/**
 * The browser's half of the playground: one `connectSession` client per live
 * session, and the reactive rows the sidebar reads.
 *
 * The clients are objects, not state — they live in a plain `Map` outside the
 * reactive proxy. What is reactive is the ROWS: id, agent, model, state, mode.
 * Same discipline the single-session version had, N times.
 */
import { signal } from 'sigx';
import { connectSession, type AgentSessionClient, type SessionTransport } from '@sigx/ai-agent/wire';
import { agentCatalog, agentCommand, agentEvents, agentOpenSession, agentSessions } from './agent.server';
import type { AgentCatalog, OpenRequest, SessionInfo } from './catalog';

export interface PlaygroundState {
    rows: SessionInfo[];
    catalog: AgentCatalog | undefined;
    /** The session whose pane is showing. */
    selected: string;
    /** Show every pane side by side instead of one. */
    compare: boolean;
    error: string;
    ready: boolean;
    /** A session is being opened — spawning a harness takes seconds. */
    opening: boolean;
}

export interface Playground {
    readonly state: PlaygroundState;
    client(sessionId: string): AgentSessionClient | undefined;
    refresh(): Promise<void>;
    open(request: OpenRequest): Promise<void>;
    close(sessionId: string): Promise<void>;
    select(sessionId: string): void;
    disconnectAll(): void;
}

export function createPlayground(): Playground {
    const state = signal<PlaygroundState>({ rows: [], catalog: undefined, selected: '', compare: false, error: '', ready: false, opening: false });
    const clients = new Map<string, AgentSessionClient>();

    /**
     * One transport per session. `sessionId` travels beside the wire command,
     * never inside it — the envelope is the library's, the routing is ours.
     */
    const transportFor = (sessionId: string): SessionTransport => ({
        send: (command) => agentCommand({ sessionId, command }),
        events: (from) => agentEvents(from ? { sessionId, from } : { sessionId })
    });

    const patch = (sessionId: string, change: Partial<SessionInfo>) => {
        state.rows = state.rows.map((row) => (row.sessionId === sessionId ? { ...row, ...change } : row));
    };

    const forget = (sessionId: string) => {
        clients.delete(sessionId);
        state.rows = state.rows.filter((row) => row.sessionId !== sessionId);
        if (state.selected === sessionId) state.selected = state.rows[0]?.sessionId ?? '';
    };

    /**
     * Follow a session for the sidebar. This costs no extra request: the
     * client republishes what its own stream already carries, so `subscribe()`
     * reads a local buffer. When it ends, the session is gone.
     */
    function watch(sessionId: string, client: AgentSessionClient): void {
        void (async () => {
            try {
                for await (const event of client.subscribe()) {
                    if (event.type === 'state') patch(sessionId, { state: event.value });
                    else if (event.type === 'config') patch(sessionId, { config: event.options });
                }
            } catch {
                // A session that failed is still a session that ended.
            } finally {
                forget(sessionId);
            }
        })();
    }

    async function attach(info: SessionInfo): Promise<void> {
        if (clients.has(info.sessionId)) return;
        const client = await connectSession(transportFor(info.sessionId), {
            from: { epoch: 0, seq: 0 },
            // A reload of a long session replays everything into this buffer
            // BEFORE the pane mounts, and `useAgentSession` then subscribes
            // from `{0,0}` — with the default 2000 the start would already be
            // evicted and that subscribe throws, leaving an empty transcript.
            bufferSize: 50_000
        });
        clients.set(info.sessionId, client);
        state.rows = [...state.rows, info];
        if (!state.selected) state.selected = info.sessionId;
        watch(info.sessionId, client);
    }

    return {
        state,
        client: (sessionId) => clients.get(sessionId),

        /**
         * Read the server's list and join anything not already joined — which
         * is how a second tab finds the sessions the first one opened and
         * becomes a late observer of every one of them.
         */
        async refresh() {
            try {
                const [catalog, sessions] = await Promise.all([agentCatalog({}), agentSessions({})]);
                state.catalog = catalog;
                // One session that will not attach must not stop the others.
                for (const info of sessions) {
                    await attach(info).catch((e: unknown) => {
                        state.error = `Could not follow session ${info.sessionId}: ${e instanceof Error ? e.message : String(e)}`;
                        console.error('[agent] attach failed', e);
                    });
                }
            } finally {
                state.ready = true;
            }
        },

        /**
         * Never let this fail silently. Opening crosses two network calls and
         * can spawn a process; a rejection anywhere used to vanish into the
         * `void` at the call site, and the page just sat there.
         */
        async open(request) {
            state.error = '';
            state.opening = true;
            try {
                const result = await agentOpenSession(request);
                if (!result.ok) {
                    state.error = result.reason;
                    // The catalogue learned why; re-read it so the form can
                    // grey the agent out and show the install hint.
                    state.catalog = await agentCatalog({}).catch(() => state.catalog);
                    return;
                }
                await attach(result.session);
                state.selected = result.session.sessionId;
            } catch (e) {
                state.error = `Could not open a ${request.agent} session: ${e instanceof Error ? e.message : String(e)}`;
                console.error('[agent] open failed', e);
            } finally {
                state.opening = false;
            }
        },

        /**
         * Closing is the wire's own `close` command — no endpoint of ours. The
         * server reaps the session, and every other tab watching it sees
         * `state: 'closed'` and drops its row too.
         */
        async close(sessionId) {
            const client = clients.get(sessionId);
            if (!client) return;
            // Drop it locally whatever the server says: a session we cannot
            // reach is not one the sidebar should keep offering.
            await client.close().catch((e: unknown) => console.warn('[agent] close failed', e));
            forget(sessionId);
        },

        select(sessionId) {
            state.selected = sessionId;
        },

        disconnectAll() {
            for (const client of clients.values()) client.disconnect();
            clients.clear();
        }
    };
}
