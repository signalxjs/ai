/**
 * Record and replay — deterministic fixtures for any adapter.
 *
 * `recordAgent` wraps an agent and writes down, per session, one ordered log:
 * the client's commands (`prompt`, `respond`, `cancel`, `configure`,
 * `close`) interleaved with every event the session emitted. `replayAgent`
 * plays that log back through the real session helpers: events until the
 * next recorded command, then it waits for the client to issue exactly that
 * command — anything else throws with a diff. A recorded live run thus
 * becomes a fixture test that exercises the same client code path.
 */

import type { JsonSchema } from '@sigx/ai';
import type { AgentCapabilities, AgentEvent, Decision, PromptPart, UnstampedEvent } from '../protocol/index.js';
import { AgentError, toPromptParts } from '../protocol/index.js';
import type { Agent, AgentSession, AgentTurn, CancelTarget, EventCursor, PromptOptions, SessionOptions, SessionRef, SessionSummary } from '../session/index.js';
import { createEventLog, createSessionCore, failedTurn } from '../session/index.js';
import type { TurnDriver } from '../session/index.js';
import { jsonEqual, jsonRoundTrip } from '../utils/json.js';

export const FIXTURE_VERSION = 1;

/** The JSON-safe part of `SessionOptions` (tools and policies are functions and are named only). */
export interface FixtureSessionOptions {
    readonly system?: string;
    readonly model?: string;
    readonly interactive?: boolean;
    readonly requestTimeoutMs?: number;
    readonly resume?: SessionRef;
    readonly fork?: boolean;
    readonly toolNames?: readonly string[];
    readonly hasPolicy?: boolean;
    /** Adapter-specific options that survived JSON. */
    readonly extra?: Readonly<Record<string, unknown>>;
}

export type FixtureCommand =
    | { readonly kind: 'prompt'; readonly turnId: string; readonly input: readonly PromptPart[]; readonly output?: JsonSchema }
    | { readonly kind: 'respond'; readonly requestId: string; readonly decision: Decision }
    | { readonly kind: 'cancel'; readonly agentId?: string }
    | { readonly kind: 'configure'; readonly patch: Readonly<Record<string, string>> }
    | { readonly kind: 'close' };

export type FixtureEntry = { readonly command: FixtureCommand } | { readonly event: AgentEvent };

export interface FixtureSession {
    readonly id: string;
    readonly options: FixtureSessionOptions;
    /** The ref when the session opened and when it closed. */
    readonly ref: { readonly initial: SessionRef; final?: SessionRef };
    /** Commands interleaved with events, in the order a client experienced them. */
    log: FixtureEntry[];
}

export interface AgentFixture {
    readonly version: typeof FIXTURE_VERSION;
    readonly agent: { readonly id: string; readonly capabilities: AgentCapabilities };
    readonly sessions: FixtureSession[];
    /** Every `listSessions()` result, in call order — present only when the recorded agent had `listSessions`. */
    listSessions?: SessionSummary[][];
}

const KNOWN_OPTION_KEYS = new Set(['system', 'model', 'tools', 'policy', 'interactive', 'requestTimeoutMs', 'resume', 'fork', 'signal']);

function fixtureOptions(options: SessionOptions & Record<string, unknown>): FixtureSessionOptions {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(options)) {
        if (KNOWN_OPTION_KEYS.has(k) || v === undefined || typeof v === 'function') continue;
        try {
            extra[k] = jsonRoundTrip(v);
        } catch {
            // Not JSON — not recorded.
        }
    }
    return {
        ...(options.system !== undefined ? { system: options.system } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
        ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
        ...(options.fork !== undefined ? { fork: options.fork } : {}),
        ...(options.tools ? { toolNames: options.tools.map((t) => t.name) } : {}),
        ...(options.policy ? { hasPolicy: true } : {}),
        ...(Object.keys(extra).length ? { extra } : {})
    };
}

function outputSchema(options: PromptOptions | undefined): JsonSchema | undefined {
    const schema = options?.output?.schema;
    if (!schema) return undefined;
    if ('~standard' in schema) {
        const conv = (schema as { '~standard': { jsonSchema?: { input: (o: { target: string }) => JsonSchema } } })['~standard'].jsonSchema;
        return conv ? conv.input({ target: 'draft-2020-12' }) : { note: 'standard schema without a JSON Schema converter' };
    }
    return schema as JsonSchema;
}

export interface RecordAgentOptions {
    /** Called with the fixture so far each time a recorded session closes. */
    readonly onRecord?: (fixture: AgentFixture) => void;
}

export interface RecordingAgent extends Agent {
    readonly fixture: AgentFixture;
}

/** Wrap `agent`; every session opened through the wrapper is recorded into `fixture`. */
export function recordAgent(agent: Agent, options: RecordAgentOptions = {}): RecordingAgent {
    const fixture: AgentFixture = { version: FIXTURE_VERSION, agent: { id: agent.id, capabilities: agent.capabilities }, sessions: [], ...(agent.listSessions ? { listSessions: [] } : {}) };
    return {
        id: agent.id,
        capabilities: agent.capabilities,
        fixture,
        ...(agent.listSessions
            ? {
                  listSessions: async () => {
                      const summaries = await agent.listSessions!();
                      fixture.listSessions!.push(structuredClone(summaries));
                      return summaries;
                  }
              }
            : {}),
        async session(sessionOptions = {}) {
            const real = await agent.session(sessionOptions);
            const recorded: FixtureSession = { id: real.id, options: fixtureOptions(sessionOptions as SessionOptions & Record<string, unknown>), ref: { initial: real.ref }, log: [] };
            fixture.sessions.push(recorded);
            // Events arrive here through a subscription, i.e. later than the client
            // sees them on its turn; a command is therefore placed after the last
            // event the client had observed when it issued it, and the log is
            // merged in that order.
            const events: AgentEvent[] = [];
            const commands: { command: FixtureCommand; after: EventCursor }[] = [];
            let observed: EventCursor = { epoch: 0, seq: 0 };
            const observe = (e: AgentEvent) => {
                if (e.epoch > observed.epoch || (e.epoch === observed.epoch && e.seq > observed.seq)) observed = { epoch: e.epoch, seq: e.seq };
            };
            const observing = <T extends AsyncIterable<AgentEvent>>(source: T): AsyncIterable<AgentEvent> => ({
                async *[Symbol.asyncIterator]() {
                    for await (const e of source) {
                        observe(e);
                        yield e;
                    }
                }
            });
            const rebuild = () => {
                recorded.log = mergeLog(events, commands);
            };
            // From an "always old" cursor, so events the session emitted while
            // opening (a `config`, an `ext`) are recorded too, not only live ones.
            // The pump's own position counts as observed too: a client that only
            // awaits `turn.result` never reads events, yet its next command still
            // came after everything the session had emitted by then.
            const pump = (async () => {
                for await (const e of real.subscribe({ epoch: 0, seq: 0 })) {
                    events.push(e);
                    observe(e);
                }
            })();
            const command = (c: FixtureCommand, after: EventCursor = observed) => {
                commands.push({ command: c, after });
            };
            const session: AgentSession = {
                id: real.id,
                get ref() {
                    return real.ref;
                },
                prompt(input, promptOptions) {
                    // A steer comes back as the running turn's handle, so its command names that turn.
                    const turn = real.prompt(input, promptOptions);
                    const schema = outputSchema(promptOptions);
                    command({ kind: 'prompt', turnId: turn.id, input: toPromptParts(input), ...(schema ? { output: schema } : {}) });
                    const wrapped: AgentTurn = { id: turn.id, result: turn.result, [Symbol.asyncIterator]: () => observing(turn)[Symbol.asyncIterator]() };
                    return wrapped;
                },
                respond(requestId, decision) {
                    command({ kind: 'respond', requestId, decision });
                    return real.respond(requestId, decision);
                },
                cancel(target) {
                    command(cancelCommand(target));
                    return real.cancel(target);
                },
                ...(real.configure
                    ? {
                          configure: (patch: Readonly<Record<string, string>>) => {
                              command({ kind: 'configure', patch });
                              return real.configure!(patch);
                          }
                      }
                    : {}),
                subscribe: (from) => observing(real.subscribe(from)),
                async close() {
                    // After every event: closing ends the session's log.
                    command({ kind: 'close' }, { epoch: Number.MAX_SAFE_INTEGER, seq: 0 });
                    await real.close();
                    // After the close: an adapter may update its ref while closing.
                    recorded.ref.final = real.ref;
                    await pump.catch(() => {});
                    rebuild();
                    options.onRecord?.(fixture);
                }
            };
            return session;
        },
        dispose: () => agent.dispose()
    };
}

/** Events in `(epoch, seq)` order, each command right after the last event its client had seen (issue order among equals). */
function mergeLog(events: readonly AgentEvent[], commands: readonly { command: FixtureCommand; after: EventCursor }[]): FixtureEntry[] {
    const sorted = [...events].sort((a, b) => a.epoch - b.epoch || a.seq - b.seq);
    const out: FixtureEntry[] = [];
    let ci = 0;
    const before = (a: EventCursor, b: EventCursor) => a.epoch < b.epoch || (a.epoch === b.epoch && a.seq < b.seq);
    for (const e of sorted) {
        while (ci < commands.length && before(commands[ci]!.after, e)) out.push({ command: commands[ci++]!.command });
        out.push({ event: e });
    }
    while (ci < commands.length) out.push({ command: commands[ci++]!.command });
    return out;
}

/** The client did something the recording did not: the diff names both sides. */
export class ReplayMismatchError extends Error {
    override readonly name = 'ReplayMismatchError';
    constructor(
        readonly expected: unknown,
        readonly actual: unknown,
        what = 'command'
    ) {
        super(`[sigx ai-agent] replay mismatch — the recording expected ${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}

export interface ReplayAgentOptions {
    /** Also compare the JSON-safe session options against the recording. Default `true`. */
    readonly checkSessionOptions?: boolean;
}

/** An `Agent` that replays `fixture`; the client must issue the recorded commands in order. */
export function replayAgent(fixture: AgentFixture, options: ReplayAgentOptions = {}): Agent {
    if (fixture.version !== FIXTURE_VERSION) throw new AgentError('protocol_error', `[sigx ai-agent] unsupported fixture version ${String(fixture.version)}`);
    let nextSession = 0;
    let nextListing = 0;
    const sessions: AgentSession[] = [];

    return {
        id: fixture.agent.id,
        capabilities: fixture.agent.capabilities,
        ...(fixture.listSessions
            ? {
                  listSessions: async (): Promise<SessionSummary[]> => {
                      const listed = fixture.listSessions![nextListing++];
                      if (!listed) throw new ReplayMismatchError(undefined, { kind: 'listSessions' }, 'no further listSessions result');
                      return structuredClone(listed);
                  }
              }
            : {}),
        async session(sessionOptions = {}) {
            const recorded = fixture.sessions[nextSession++];
            if (!recorded) throw new ReplayMismatchError(undefined, fixtureOptions(sessionOptions as SessionOptions & Record<string, unknown>), 'no further session');
            if (options.checkSessionOptions !== false) {
                const actual = fixtureOptions(sessionOptions as SessionOptions & Record<string, unknown>);
                if (!jsonEqual(actual, recorded.options)) throw new ReplayMismatchError(recorded.options, actual, 'session options');
            }
            const firstEvent = recorded.log.find((e): e is { event: AgentEvent } => 'event' in e)?.event;
            const log = createEventLog({ sessionId: recorded.id, epoch: firstEvent?.epoch ?? 1 });
            const core = createSessionCore({ id: recorded.id, log, interactive: sessionOptions.interactive ?? true, steer: fixture.agent.capabilities.steer, subagents: fixture.agent.capabilities.subagents });
            let cursor = 0;
            let waiting: { expected: FixtureCommand; resolve: () => void } | undefined;

            /** The client issued `actual`: match it against the recording (now or when the replay reaches it). */
            const issue = (actual: FixtureCommand): Promise<void> =>
                new Promise<void>((resolve, reject) => {
                    if (!waiting && (!core.current || core.current.settled)) advance();
                    const expected = waiting?.expected ?? nextCommand();
                    if (!expected || !sameCommand(expected, actual)) {
                        reject(new ReplayMismatchError(expected, actual));
                        return;
                    }
                    if (waiting) {
                        const w = waiting;
                        waiting = undefined;
                        cursor++;
                        w.resolve();
                        resolve();
                    } else {
                        cursor++;
                        resolve();
                    }
                });

            const nextCommand = (): FixtureCommand | undefined => {
                const entry = recorded.log[cursor];
                return entry && 'command' in entry ? entry.command : undefined;
            };

            /** Emit events until the next command (returned) or the turn's end (`'turn-end'`). */
            const advance = (driver?: TurnDriver): FixtureCommand | 'turn-end' | 'end' => {
                for (;;) {
                    const entry = recorded.log[cursor];
                    if (!entry) return 'end';
                    if ('command' in entry) return entry.command;
                    const { sessionId: _s, epoch: _e, seq: _q, turnId: _t, ...payload } = entry.event;
                    cursor++;
                    if (payload.type === 'state') continue; // the replay's own core emits these
                    if (driver && entry.event.turnId === driver.turnId) {
                        if (payload.type === 'turn-start') continue; // emitted by createTurn
                        if (payload.type === 'turn-end') {
                            const { type: _type, parentCallId: _p, ...end } = payload;
                            driver.end(end);
                            return 'turn-end';
                        }
                        driver.emit(payload as UnstampedEvent);
                    } else if (entry.event.turnId === undefined) {
                        core.emit(payload as UnstampedEvent);
                    }
                    // Events of another turn (steering) are left to that turn's driver.
                }
            };

            const session: AgentSession = {
                id: recorded.id,
                get ref() {
                    return recorded.ref.final ?? recorded.ref.initial;
                },
                prompt(input, promptOptions) {
                    const schema = outputSchema(promptOptions);
                    const running = core.current && !core.current.settled ? core.current : undefined;
                    if (running && fixture.agent.capabilities.steer) {
                        // A steer: the recording expects a prompt into the running turn here; the
                        // `user-message` it produced replays through the turn's own loop.
                        const actual: FixtureCommand = { kind: 'prompt', turnId: running.id, input: toPromptParts(input), ...(schema ? { output: schema } : {}) };
                        const expected = waiting?.expected ?? nextCommand();
                        if (!expected || expected.kind !== 'prompt' || expected.turnId !== running.id || !sameCommand(expected, actual)) return failedTurn(running.id, new ReplayMismatchError(expected, actual));
                        const handle = core.steer(input, promptOptions);
                        issue(actual).catch(() => {});
                        return handle;
                    }
                    if (!running) advance(); // session-level events recorded before this prompt
                    const expected = nextCommand();
                    // A caller-supplied turnId must be the recorded one; otherwise the recorded id is used.
                    const turnId = promptOptions?.turnId ?? (expected?.kind === 'prompt' ? expected.turnId : '');
                    const actual: FixtureCommand = { kind: 'prompt', turnId, input: toPromptParts(input), ...(schema ? { output: schema } : {}) };
                    if (!expected || !sameCommand(expected, actual) || (expected.kind === 'prompt' && expected.turnId !== turnId)) {
                        return failedTurn(turnId || 'replay', new ReplayMismatchError(expected, actual));
                    }
                    cursor++;
                    const turn: AgentTurn = core.startTurn(input, { ...promptOptions, turnId: actual.turnId }, async (driver, ctx) => {
                        // Steering input is consumed here; the recorded `user-message` is what replays.
                        ctx.onSteer(() => {});
                        for (;;) {
                            const next = advance(driver);
                            if (next === 'turn-end') return;
                            if (next === 'end') throw new ReplayMismatchError('turn-end', 'end of recording', 'the recorded turn to end');
                            // A prompt into this very turn is a steer the client still has to issue; another turn's prompt means this one should have ended.
                            if (next.kind === 'close' || (next.kind === 'prompt' && next.turnId !== driver.turnId)) throw new ReplayMismatchError('turn-end', next, 'the recorded turn to end before');
                            await new Promise<void>((resolve) => {
                                waiting = { expected: next, resolve };
                            });
                        }
                    });
                    return turn;
                },
                respond: (requestId, decision) => issue({ kind: 'respond', requestId, decision }),
                cancel: (target) => issue(cancelCommand(target)),
                ...(fixture.agent.capabilities.config
                    ? {
                          configure: async (patch: Readonly<Record<string, string>>) => {
                              await issue({ kind: 'configure', patch });
                              if (!core.current || core.current.settled) advance();
                          }
                      }
                    : {}),
                subscribe: (from) => core.subscribe(from),
                async close() {
                    // Closing is a command like any other: it must be what the recording
                    // expects next (or the recording must be exhausted, for a session that
                    // was never closed on record).
                    advance(); // trailing session-level events (the recorder places `close` after everything)
                    const expected = nextCommand();
                    const remaining = recorded.log.slice(cursor).filter((e) => 'command' in e);
                    if (expected?.kind === 'close') cursor++;
                    else if (remaining.length) {
                        await core.close();
                        throw new ReplayMismatchError(expected ?? remaining[0]!.command, { kind: 'close' });
                    }
                    await core.close();
                }
            };
            sessions.push(session);
            return session;
        },
        async dispose() {
            await Promise.all(sessions.map((s) => s.close()));
        }
    };
}

function cancelCommand(target: CancelTarget | undefined): FixtureCommand {
    return { kind: 'cancel', ...(target?.agentId !== undefined ? { agentId: target.agentId } : {}) };
}

function sameCommand(a: FixtureCommand, b: FixtureCommand): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'prompt' && b.kind === 'prompt') return jsonEqual(a.input, b.input) && jsonEqual(a.output, b.output);
    return jsonEqual(a, b);
}

/** Stable JSON (sorted keys, two-space indent) so committed fixtures diff cleanly. */
export function serializeFixture(fixture: AgentFixture): string {
    return JSON.stringify(sortKeys(fixture), null, 2) + '\n';
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
        return out;
    }
    return value;
}
