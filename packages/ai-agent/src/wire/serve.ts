/**
 * `serveSession` — expose one `AgentSession` to remote clients.
 *
 * Commands come in through `handleCommand` (idempotent by `commandId`, run
 * through `authorize` first), events go out through `events(from)`: a
 * `hello`, a replay from the session's buffer — or from an `EventLogStore`
 * when the buffer has moved on, or a `gap` when there is none — then live.
 * Topology (WebSocket, `serverStream`, a relay) is the app's business.
 */

import type { AgentCapabilities, AgentEvent } from '../protocol/index.js';
import { AgentError, SessionBusyError } from '../protocol/index.js';
import type { AgentSession } from '../session/index.js';
import type { EventLogStore } from '../store/index.js';
import { createQueue } from '../utils/queue.js';
import { coalesceFrames, type CoalesceOptions } from './coalesce.js';
import { cursorBefore, isWireCommand, WIRE_PROTOCOL_VERSION, type Cursor, type WireCommand, type WireErrorCode, type WireFrame, type WireReply } from './envelope.js';

export interface ServeSessionOptions {
    readonly agentId: string;
    readonly capabilities: AgentCapabilities;
    /** Durable events for replay beyond the in-memory buffer; every event is appended as it happens. */
    readonly eventLog?: EventLogStore;
    /** Per-principal command authorization; runs before idempotency, so a replayed unauthorized command stays refused. */
    readonly authorize?: (command: WireCommand, principal: unknown) => boolean | Promise<boolean>;
    /** Merge consecutive text deltas on the way out. Off by default. */
    readonly coalesce?: CoalesceOptions | false;
    /** Replies remembered for idempotent retries. Default 256. */
    readonly commandCacheSize?: number;
    /** Live events buffered while a store replay fills a gap; beyond it the stream fails. Default 10 000. */
    readonly tailBufferSize?: number;
}

export interface ServedSession {
    readonly sessionId: string;
    /** The last `(epoch, seq)` the session has emitted. */
    readonly head: Cursor;
    handleCommand(command: WireCommand, principal?: unknown): Promise<WireReply>;
    events(from?: Cursor, options?: { readonly signal?: AbortSignal }): AsyncIterable<WireFrame>;
    /** Stop serving (does not close the session). */
    close(): Promise<void>;
}

const V = WIRE_PROTOCOL_VERSION;
const PART_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'file', 'resource']);
const DECISION_TYPES: ReadonlySet<string> = new Set(['permission', 'input', 'cancel']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `PromptPart` with the fields its variant requires: a `text` part its `text`, an `image` / `file` part a `mediaType` and exactly one of `data` / `url`, a `resource` part its `uri`. */
function isPromptPart(p: unknown): boolean {
    if (!isRecord(p) || typeof p.type !== 'string' || !PART_TYPES.has(p.type)) return false;
    switch (p.type) {
        case 'text':
            return typeof p.text === 'string';
        case 'image':
        case 'file':
            return typeof p.mediaType === 'string' && (typeof p.data === 'string') !== (typeof p.url === 'string');
        default:
            return typeof p.uri === 'string';
    }
}

/** The shape each command must have before it may reach the session; the reason it does not, otherwise. */
function validateCommand(command: WireCommand): string | undefined {
    switch (command.type) {
        case 'prompt': {
            if (typeof command.turnId !== 'string' || command.turnId.trim() === '') return 'prompt.turnId must be a non-empty string';
            const input: unknown = command.input;
            if (!Array.isArray(input) || !input.every(isPromptPart)) return 'prompt.input must be an array of prompt parts (text with text; image/file with mediaType and one of data/url; resource with uri)';
            const output: unknown = command.output;
            if (output !== undefined && (!isRecord(output) || !isRecord(output.schema))) return 'prompt.output must carry a JSON Schema object';
            return undefined;
        }
        case 'respond': {
            if (typeof command.requestId !== 'string') return 'respond.requestId must be a string';
            const decision: unknown = command.decision;
            if (!isRecord(decision) || typeof decision.type !== 'string' || !DECISION_TYPES.has(decision.type)) return 'respond.decision must be a permission, input or cancel decision';
            if (decision.type === 'permission' && ((decision.outcome !== 'allow' && decision.outcome !== 'deny') || (decision.scope !== 'once' && decision.scope !== 'session'))) {
                return 'respond.decision: a permission decision needs outcome allow|deny and scope once|session';
            }
            if (decision.type === 'input' && !Object.hasOwn(decision, 'answers')) return 'respond.decision: an input decision needs answers';
            return undefined;
        }
        case 'configure': {
            const patch: unknown = command.patch;
            if (!isRecord(patch) || !Object.values(patch).every((v) => typeof v === 'string')) return 'configure.patch must be an object of strings';
            return undefined;
        }
        default:
            return undefined;
    }
}

export function serveSession(session: AgentSession, options: ServeSessionOptions): ServedSession {
    const cacheSize = options.commandCacheSize ?? 256;
    const replies = new Map<string, Promise<WireReply>>();
    let head: Cursor = { epoch: 0, seq: 0 };
    let serving = true;

    // Track the head (and feed the store) from everything the session has
    // buffered. Serving ends with this subscription: when it drops, `hello.head`
    // and `gap.resumeAt` would go stale, so commands are refused from then on.
    const tracking = session.subscribe({ epoch: 0, seq: 0 })[Symbol.asyncIterator]();
    const tracker = (async () => {
        try {
            for (;;) {
                const next = await tracking.next();
                if (next.done) break;
                head = { epoch: next.value.epoch, seq: next.value.seq };
                if (options.eventLog) await options.eventLog.append(next.value);
            }
        } catch (e) {
            if (__DEV__) console.warn(`[sigx ai-agent] serveSession("${session.id}") stopped tracking events: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            serving = false;
        }
    })();

    const remember = (commandId: string, reply: Promise<WireReply>) => {
        replies.set(commandId, reply);
        if (replies.size > cacheSize) replies.delete(replies.keys().next().value as string);
    };

    const execute = async (command: WireCommand): Promise<WireReply> => {
        const ack = (turnId?: string): WireReply => ({ v: V, kind: 'ack', commandId: command.commandId, ...(turnId !== undefined ? { turnId } : {}) });
        const error = (code: WireErrorCode, message: string): WireReply => ({ v: V, kind: 'error', commandId: command.commandId, code, message });
        try {
            switch (command.type) {
                case 'prompt': {
                    const turn = session.prompt(command.input, { turnId: command.turnId, ...(command.output ? { output: command.output } : {}) });
                    // A busy session surfaces on the turn's result; anything else is the client's to observe.
                    const busy = await Promise.race([turn.result.then(() => undefined, (e: unknown) => e), Promise.resolve().then(() => undefined)]);
                    if (busy instanceof SessionBusyError) return error('busy', busy.message);
                    if (busy instanceof Error) return error(busy instanceof AgentError && busy.code === 'protocol_error' && /closed/.test(busy.message) ? 'closed' : 'internal', busy.message);
                    turn.result.catch(() => {});
                    return ack(turn.id);
                }
                case 'respond':
                    await session.respond(command.requestId, command.decision);
                    return ack();
                case 'cancel':
                    await session.cancel();
                    return ack();
                case 'configure':
                    if (!session.configure) return error('unsupported', `session "${session.id}" does not support configure()`);
                    await session.configure(command.patch);
                    return ack();
                case 'close':
                    await session.close();
                    return ack();
            }
        } catch (e) {
            return error('internal', e instanceof Error ? e.message : String(e));
        }
        return error('invalid', `unknown command type "${String((command as { type: unknown }).type)}"`);
    };

    const toFrame = (e: AgentEvent): WireFrame => ({ v: V, kind: 'event', epoch: e.epoch, seq: e.seq, event: e });

    async function* frames(from: Cursor | undefined, signal: AbortSignal | undefined): AsyncGenerator<WireFrame, void, undefined> {
        // Subscribe BEFORE the `hello` goes out: a consumer may act on the hello
        // (prompt, say) before it pulls the next frame, and nothing emitted in
        // between may be lost.
        let source: AsyncIterable<AgentEvent>;
        let last: Cursor | undefined = from;
        let evicted: { readonly live: ReturnType<typeof createQueue<AgentEvent>>; readonly release: () => void } | undefined;
        if (!from) source = session.subscribe();
        else {
            try {
                source = session.subscribe(from);
            } catch (e) {
                if (!(e instanceof AgentError) || e.code !== 'protocol_error') throw e;
                // The buffer moved on: subscribe to the live tail now (nothing is
                // missed) and drain it into our own bounded queue while the store
                // fills the middle — a long replay must not overflow the session's
                // per-subscriber backlog.
                const liveIterator = session.subscribe()[Symbol.asyncIterator]();
                let released = false;
                const release = () => {
                    if (released) return;
                    released = true;
                    void liveIterator.return?.();
                };
                // Bounded like the session's own subscriber queues: a stalled store
                // replay must fail the stream, not grow memory without limit.
                const live = createQueue<AgentEvent>({ onClose: release, maxSize: options.tailBufferSize ?? 10_000 });
                void (async () => {
                    try {
                        for (;;) {
                            const next = await liveIterator.next();
                            if (next.done) break;
                            live.push(next.value);
                        }
                        live.end();
                    } catch (e) {
                        live.fail(e);
                    }
                })();
                evicted = { live, release };
                source = live;
            }
        }
        const hello: WireFrame = { v: V, kind: 'hello', agentId: options.agentId, sessionId: session.id, sessionRef: session.ref, capabilities: options.capabilities, head };
        if (evicted) {
            let handedOff = false;
            try {
                yield hello;
                if (options.eventLog) {
                    for await (const e of options.eventLog.read(session.id, from!)) {
                        if (signal?.aborted) return;
                        if (last && !cursorBefore(last, e)) continue;
                        last = { epoch: e.epoch, seq: e.seq };
                        yield toFrame(e);
                    }
                } else {
                    yield { v: V, kind: 'gap', from: from!, resumeAt: head };
                    last = head;
                }
                handedOff = true;
            } finally {
                // Left before the tail took over (abort, a store error): release the live subscription.
                if (!handedOff) {
                    evicted.live.end();
                    evicted.release();
                }
            }
        } else {
            try {
                yield hello;
            } catch (e) {
                await source[Symbol.asyncIterator]().return?.();
                throw e;
            }
        }
        const iterator = source[Symbol.asyncIterator]();
        const onAbort = () => {
            void iterator.return?.();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            for (;;) {
                const next = await iterator.next();
                if (next.done || signal?.aborted) return;
                const e = next.value;
                if (last && !cursorBefore(last, e)) continue; // already delivered from the store
                last = { epoch: e.epoch, seq: e.seq };
                yield toFrame(e);
            }
        } finally {
            signal?.removeEventListener('abort', onAbort);
            await iterator.return?.();
        }
    }

    return {
        sessionId: session.id,
        get head() {
            return head;
        },
        async handleCommand(command, principal) {
            const commandId = (command as { commandId?: string } | null | undefined)?.commandId ?? '';
            if (!serving) return { v: V, kind: 'error', commandId, code: 'closed', message: `session "${session.id}" is no longer served` };
            if (!isWireCommand(command)) return { v: V, kind: 'error', commandId, code: 'invalid', message: 'not a wire command' };
            // Payloads come from a transport that parsed JSON from elsewhere: a
            // malformed one is refused here, never handed to the session. Not cached,
            // so the corrected command runs under the same id.
            const invalid = validateCommand(command);
            if (invalid) return { v: V, kind: 'error', commandId: command.commandId, code: 'invalid', message: invalid };
            if (options.authorize) {
                // One structured reply per command, even when the app's authorizer fails.
                let allowed: boolean;
                try {
                    allowed = await options.authorize(command, principal);
                } catch (e) {
                    return { v: V, kind: 'error', commandId: command.commandId, code: 'internal', message: `authorization failed: ${e instanceof Error ? e.message : String(e)}` };
                }
                if (!allowed) return { v: V, kind: 'error', commandId: command.commandId, code: 'unauthorized', message: `command "${command.type}" is not allowed` };
            }
            const cached = replies.get(command.commandId);
            if (cached) {
                // Least recently USED: a retried command stays hot.
                replies.delete(command.commandId);
                replies.set(command.commandId, cached);
                return cached;
            }
            const reply = execute(command);
            remember(command.commandId, reply);
            return reply;
        },
        events(from, o) {
            const stream = frames(from, o?.signal);
            return options.coalesce ? coalesceFrames(stream, options.coalesce) : stream;
        },
        async close() {
            serving = false;
            await tracking.return?.();
            await tracker;
        }
    };
}
