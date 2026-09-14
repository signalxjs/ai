/**
 * The live sessions, and the agents hosting them.
 *
 * `serveSession` serves ONE session and the wire envelope has no create or
 * list verb — deliberately, because topology is an app's business, not the
 * library's. This is that app half: a map of served sessions keyed by id, and
 * a map of agents keyed by what they host, refcounted so a harness process
 * outlives its first conversation and dies with its last.
 *
 * Nothing here runs at import. A session exists only once someone asks for
 * one, which is what lets the DOM test import the endpoints without spawning
 * a CLI, and what makes `agentSessions()` empty a provable fact.
 */
import { memoryEventLog, type Agent, type AgentSession, type ConfigOption, type SessionState } from '@sigx/ai-agent';
import { serveSession, type ServedSession } from '@sigx/ai-agent/wire';
import { MAX_SESSIONS, type AgentCatalog, type AgentChoice, type OpenRequest, type OpenResult, type SessionInfo } from './catalog.js';
import { createAgent, defaults, entries, sessionOptionsFor, unavailable } from './agents.server.js';

interface Entry {
    /** The host this session borrows; the key into `hosts`. */
    readonly key: string;
    readonly session: AgentSession;
    readonly served: ServedSession;
    /** Replaced by the watcher as the session reports; `list()` copies it. */
    info: SessionInfo;
}

const entriesById = new Map<string, Entry>();
const hosts = new Map<string, { agent: Agent; sessions: Set<string> }>();
/** Why an agent last refused to start, for the catalogue. Learned, never probed. */
const failures = new Map<AgentChoice, string>();

/**
 * One event log for every session: `memoryEventLog` already keys its buffer by
 * session id, so a second instance would buy nothing but bookkeeping.
 */
const eventLog = memoryEventLog();

/**
 * A harness hosts many sessions in one process, so every session of one shares
 * an agent. Our own engine and the mock are in-process and free, but
 * `modelAgent` bakes its model list in at construction, so they key on the
 * model too — until a session's model is switched live, which `configure()`
 * now does, at which point this can collapse to `choice` like the rest.
 */
function hostKey(choice: AgentChoice, model: string | undefined): string {
    return choice === 'sigx' || choice === 'mock' ? `${choice}:${model ?? ''}` : choice;
}

/**
 * Drop a session from the registry and, if it was its host's last, dispose the
 * agent — which for a harness kills the child process tree.
 *
 * Never dispose a host that still has sessions: that would take a live
 * conversation's process out from under it.
 */
async function release(entry: Entry): Promise<void> {
    entriesById.delete(entry.info.sessionId);
    const host = hosts.get(entry.key);
    if (!host) return;
    host.sessions.delete(entry.info.sessionId);
    if (host.sessions.size > 0) return;
    hosts.delete(entry.key);
    await host.agent.dispose().catch(() => {});
}

/**
 * Follow a session for the sidebar — and reap it when it ends.
 *
 * The subscription ends when the session's log closes, however that happened:
 * a `close` command from a tab, a harness that died, an adapter that closed
 * itself. So this is the ONE place a session is removed, which is why there is
 * no close endpoint.
 */
function watch(entry: Entry): void {
    void (async () => {
        try {
            // Live, not from `{0,0}`: this is the sidebar's feed, and the
            // session has emitted nothing worth replaying yet.
            for await (const event of entry.session.subscribe()) {
                if (event.type === 'state') entry.info = { ...entry.info, state: event.value };
                else if (event.type === 'config') entry.info = { ...entry.info, config: event.options };
            }
        } catch {
            // A session that fails is still a session that ended.
        } finally {
            await entry.served.close().catch(() => {});
            await release(entry);
        }
    })();
}

export async function open(request: OpenRequest): Promise<OpenResult> {
    if (entriesById.size >= MAX_SESSIONS) {
        return { ok: false, reason: `${MAX_SESSIONS} sessions are already open — close one first. Each holds an event stream, and a browser only allows a handful per origin.` };
    }
    const key = hostKey(request.agent, request.model);
    // Built inside the try: constructing an adapter is where a missing SDK or
    // an unresolvable executable throws, and that has to come back as a reason
    // the form can render, not an unhandled rejection.
    let host: { agent: Agent; sessions: Set<string> } | undefined = hosts.get(key);
    try {
        host ??= { agent: await createAgent(request.agent), sessions: new Set<string>() };
        const session = await host.agent.session(sessionOptionsFor(request.agent, request));
        // Read capabilities only NOW: the ACP adapter advertises a conservative
        // set until it has connected, and `session()` is what connects it.
        const info: SessionInfo = {
            sessionId: session.id,
            agent: request.agent,
            agentId: host.agent.id,
            ...(request.model ? { model: request.model } : {}),
            ...(request.cwd ? { cwd: request.cwd } : {}),
            capabilities: host.agent.capabilities,
            config: [] as readonly ConfigOption[],
            state: 'idle' as SessionState,
            createdAt: Date.now()
        };
        const entry: Entry = {
            key,
            session,
            served: serveSession(session, {
                agentId: host.agent.id,
                capabilities: host.agent.capabilities,
                eventLog,
                // One frame per run of text deltas instead of one per token:
                // the same transcript, a fraction of the messages.
                coalesce: { maxDelayMs: 40 }
            }),
            info
        };
        entriesById.set(session.id, entry);
        hosts.set(key, host);
        host.sessions.add(session.id);
        watch(entry);
        failures.delete(request.agent);
        console.log(`[agent] opened ${request.agent} (${host.agent.id}) session ${session.id}`);
        return { ok: true, session: entry.info };
    } catch (e) {
        const reason = request.agent === 'sigx' || request.agent === 'mock' ? (e instanceof Error ? e.message : String(e)) : unavailable(request.agent, e);
        failures.set(request.agent, reason);
        // A half-started harness may already own a child process — never leave
        // it behind. But only when nothing else is using it: disposing a host
        // that still has sessions would kill a live conversation's process.
        if (host && host.sessions.size === 0) {
            hosts.delete(key);
            await host.agent.dispose().catch(() => {});
        }
        console.warn(`[agent] ${request.agent} could not start: ${reason}`);
        return { ok: false, reason };
    }
}

export function served(sessionId: string): ServedSession | undefined {
    return entriesById.get(sessionId)?.served;
}

export function list(): SessionInfo[] {
    return [...entriesById.values()].map((e) => e.info).sort((a, b) => a.createdAt - b.createdAt);
}

export function catalog(): AgentCatalog {
    return { agents: entries(failures), defaults: defaults(), maxSessions: MAX_SESSIONS };
}

/** Close every session and dispose every host — for the smoke test, and for HMR. */
export async function closeAll(): Promise<void> {
    await Promise.all([...entriesById.values()].map((e) => e.session.close().catch(() => {})));
    await Promise.all([...hosts.values()].map((h) => h.agent.dispose().catch(() => {})));
    entriesById.clear();
    hosts.clear();
}

// Vite re-evaluates this module on every edit. Without this, each save would
// strand a harness child process behind a fresh, empty registry.
import.meta.hot?.dispose(() => void closeAll());
