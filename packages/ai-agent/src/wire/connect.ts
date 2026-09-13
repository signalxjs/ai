/**
 * `connectSession` — use a served session from anywhere.
 *
 * The transport is two functions (`send` a command, `events` from a cursor),
 * the same shape `useChat`'s `stream` option has, so a `serverStream` /
 * `serverFn` pair or a WebSocket fits without glue. Incoming events are
 * republished locally with their remote stamps, so several consumers can
 * `subscribe(from)`; a broken stream reconnects from the last cursor; the
 * result is an `AgentSession` a UI cannot tell from a local one.
 */

import type { AgentCapabilities, AgentEvent, Decision, PromptInput, PromptPart } from '../protocol/index.js';
import { AgentError, SessionBusyError, isAgentEvent, toPromptParts } from '../protocol/index.js';
import type { AgentSession, AgentTurn, CancelTarget, PromptOptions, SessionRef, TurnResult } from '../session/index.js';
import { generateId } from '../utils/id.js';
import { cursorBefore, isWireFrame, WIRE_PROTOCOL_VERSION, type Cursor, type WireCommand, type WireCommandPayload, type WireErrorCode, type WireFrame, type WireReply } from './envelope.js';
import { createReplayBuffer } from './replay-buffer.js';

/** How commands and frames travel — the app's transport, as two functions. */
export interface SessionTransport {
    send(command: WireCommand): Promise<WireReply>;
    events(from?: Cursor, options?: { readonly signal?: AbortSignal }): AsyncIterable<WireFrame>;
}

export interface ReconnectOptions {
    /** Consecutive failed attempts before the client gives up and reports `lost`. Default 10. */
    readonly maxAttempts?: number;
    /** Delay before attempt `n` (1-based). Default: exponential from 250 ms, capped at 10 s. */
    readonly backoffMs?: (attempt: number) => number;
}

export interface ConnectOptions {
    /** `false`: a broken stream is not retried — the client goes `lost` at once (`reconnect()` still works). Default: reconnect with backoff. */
    readonly reconnect?: false | ReconnectOptions;
    /** Start from this cursor (a late joiner replaying history); default: live from now. */
    readonly from?: Cursor;
    readonly newId?: () => string;
    /** Local replay buffer size. Default 2000. */
    readonly bufferSize?: number;
}

/**
 * Where the client stands with its transport. `lost` is not the end: the
 * session is still there and the local buffer stays open, so a `reconnect()`
 * resumes from the last cursor and pending turns carry on. `closed` is final.
 */
export type ClientStatus = 'connecting' | 'connected' | 'reconnecting' | 'lost' | 'closed';

/**
 * A command the server refused. The wire code survives as `remote`, so a
 * client can branch on `unauthorized` / `closed` / `unsupported` instead of
 * parsing a message. (A `busy` prompt is a `SessionBusyError`, as locally.)
 */
export class RemoteCommandError extends AgentError {
    constructor(
        readonly command: WireCommandPayload['type'],
        readonly remote: WireErrorCode,
        message: string
    ) {
        super('protocol_error', `[sigx ai-agent] remote ${command} failed (${remote}): ${message}`);
    }
}

export interface AgentSessionClient extends AgentSession {
    readonly agentId: string;
    readonly capabilities: AgentCapabilities;
    readonly status: ClientStatus;
    /** `status === 'connected'`. */
    readonly connected: boolean;
    /** The last remote `(epoch, seq)` seen. */
    readonly cursor: Cursor | undefined;
    /** Observe `status`; returns the unsubscribe. */
    onStatusChange(listener: (status: ClientStatus) => void): () => void;
    /** From `lost`: follow again from the last cursor with a fresh attempt budget. A no-op in any other status. */
    reconnect(): void;
    /** Stop following events without closing the remote session. Final: pending turns reject. */
    disconnect(): void;
}

const V = WIRE_PROTOCOL_VERSION;
const DEFAULT_MAX_ATTEMPTS = 10;
const defaultBackoff = (attempt: number) => Math.min(10_000, 250 * 2 ** (attempt - 1));

export async function connectSession(transport: SessionTransport, options: ConnectOptions = {}): Promise<AgentSessionClient> {
    const newId = options.newId ?? (() => generateId('cmd'));
    const buffer = createReplayBuffer(options.bufferSize !== undefined ? { size: options.bufferSize } : {});
    const reconnect = options.reconnect === false ? undefined : { maxAttempts: options.reconnect?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, backoffMs: options.reconnect?.backoffMs ?? defaultBackoff };

    let hello: Extract<WireFrame, { kind: 'hello' }> | undefined;
    let last: Cursor | undefined = options.from;
    let status: ClientStatus = 'connecting';
    const listeners = new Set<(status: ClientStatus) => void>();
    const setStatus = (value: ClientStatus) => {
        if (status === value) return;
        status = value;
        for (const listener of listeners) listener(value);
    };
    let stopped = false;
    let remoteClosed = false;
    let controller = new AbortController();
    let resolveHello!: (h: Extract<WireFrame, { kind: 'hello' }>) => void;
    let rejectHello!: (e: unknown) => void;
    const firstHello = new Promise<Extract<WireFrame, { kind: 'hello' }>>((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
    });

    const apply = (frame: WireFrame) => {
        // Transports parse JSON from elsewhere: a malformed frame is dropped (and
        // reported in dev) rather than allowed to corrupt the cursor.
        if (!isWellFormedFrame(frame)) {
            if (__DEV__) console.warn(`[sigx ai-agent] connectSession: dropped a malformed frame: ${safeJson(frame)}`);
            return;
        }
        switch (frame.kind) {
            case 'hello':
                hello = frame;
                // A live connection starts at the server's head, so a stream that
                // breaks before its first event still reconnects from a cursor.
                last ??= frame.head;
                resolveHello(frame);
                break;
            case 'event': {
                const cursor = { epoch: frame.epoch, seq: frame.seq };
                if (last && !cursorBefore(last, cursor)) return;
                buffer.push(frame.event, frame.seqFrom);
                last = cursor;
                // The session's last word: what follows is the stream ending, not a break.
                if (frame.event.type === 'state' && frame.event.value === 'closed') remoteClosed = true;
                break;
            }
            case 'gap':
                buffer.reset(frame.resumeAt);
                last = frame.resumeAt;
                break;
        }
    };

    const follow = async () => {
        let attempt = 0;
        let lastError: unknown;
        while (!stopped) {
            controller = new AbortController();
            try {
                for await (const frame of transport.events(last, { signal: controller.signal })) {
                    if (stopped) break;
                    setStatus('connected');
                    attempt = 0;
                    apply(frame);
                }
            } catch (e) {
                // A failure before the first hello goes through the same reconnect
                // policy as a later one — an initial connection is what fails most.
                lastError = e;
            }
            if (stopped || remoteClosed || !reconnect) break;
            attempt++;
            if (attempt > reconnect.maxAttempts) break;
            setStatus('reconnecting');
            await new Promise((r) => setTimeout(r, reconnect.backoffMs(attempt)));
        }
        if (remoteClosed && !stopped) {
            // A clean shutdown: the session said `closed` and the stream ended after
            // it. Nothing to come back to — end the buffer so subscribers finish.
            stopped = true;
            setStatus('closed');
            buffer.close();
            return;
        }
        if (!hello) {
            // A stream that ended or failed (and was given up on) before any hello is a failed connection, not a hang.
            const disconnected = stopped;
            stopped = true;
            setStatus('closed');
            buffer.close();
            rejectHello(lastError ?? new AgentError('protocol_error', `[sigx ai-agent] connectSession: the event stream ended before a hello frame${disconnected ? ' (disconnected)' : ''}`));
            return;
        }
        if (stopped) return; // disconnect() closed the buffer and settled the status
        // After a hello the session is known to exist: the client is lost, not
        // gone. The buffer stays open — subscribers and in-flight turns wait for
        // `reconnect()` rather than failing over a transport that may come back.
        setStatus('lost');
    };
    void follow();
    const first = await firstHello;

    const send = async (payload: WireCommandPayload): Promise<WireReply> => transport.send({ v: V, commandId: newId(), ...payload } as WireCommand);
    const sendOrThrow = async (payload: WireCommandPayload): Promise<void> => {
        const reply = await send(payload);
        if (reply.kind === 'error') throw new RemoteCommandError(payload.type, reply.code, reply.message);
    };

    const client: AgentSessionClient = {
        id: first.sessionId,
        agentId: first.agentId,
        capabilities: first.capabilities,
        get ref(): SessionRef {
            return hello?.sessionRef ?? first.sessionRef;
        },
        get status() {
            return status;
        },
        get connected() {
            return status === 'connected';
        },
        get cursor() {
            return last;
        },
        onStatusChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        reconnect() {
            if (status !== 'lost') return;
            setStatus('reconnecting');
            void follow();
        },
        prompt(input: PromptInput, promptOptions?: PromptOptions) {
            // Always a fresh id: whether this prompt starts a turn or steers the
            // running one is the server's call (it has the truth about `busy`), and
            // the ack names the turn it went into — the handle retargets to it.
            // Reusing an id this client believes is running would collide with a
            // turn that ended in the meantime.
            const turnId = promptOptions?.turnId ?? newId();
            const from = last;
            const output = promptOptions?.output ? { schema: promptOptions.output.schema as Record<string, unknown>, ...(promptOptions.output.name !== undefined ? { name: promptOptions.output.name } : {}) } : undefined;
            if (output && '~standard' in output.schema) {
                return failed(turnId, new AgentError('protocol_error', '[sigx ai-agent] a remote prompt needs a JSON Schema for output; a Standard Schema cannot cross the wire'));
            }
            // Subscribe before the command goes out, so nothing the turn emits can slip past.
            const events = buffer.subscribe(from);
            const parts = toPromptParts(input);
            const reply = send({ type: 'prompt', turnId, input: parts, ...(output ? { output } : {}) });
            return createClientTurn(first.sessionId, turnId, parts, events, reply);
        },
        respond: (requestId: string, decision: Decision) => sendOrThrow({ type: 'respond', requestId, decision }),
        cancel: (target?: CancelTarget) => sendOrThrow({ type: 'cancel', ...(target?.agentId !== undefined ? { agentId: target.agentId } : {}) }),
        ...(first.capabilities.config ? { configure: (patch: Readonly<Record<string, string>>) => sendOrThrow({ type: 'configure', patch }) } : {}),
        subscribe: (from) => buffer.subscribe(from),
        disconnect() {
            stopped = true;
            setStatus('closed');
            controller.abort();
            buffer.close();
        },
        async close() {
            try {
                await send({ type: 'close' });
            } finally {
                client.disconnect();
            }
        }
    };
    return client;
}

const isCursor = (v: unknown): v is Cursor => typeof v === 'object' && v !== null && Number.isInteger((v as Cursor).epoch) && Number.isInteger((v as Cursor).seq);

/** Shape validation for frames from the wire — the envelope plus the fields the cursor logic relies on. */
function isWellFormedFrame(frame: unknown): frame is WireFrame {
    if (!isWireFrame(frame)) return false;
    switch (frame.kind) {
        case 'hello':
            return typeof frame.sessionId === 'string' && typeof frame.agentId === 'string' && isCursor(frame.head) && typeof frame.capabilities === 'object' && frame.capabilities !== null && typeof frame.sessionRef === 'object' && frame.sessionRef !== null;
        case 'event':
            return Number.isInteger(frame.epoch) && Number.isInteger(frame.seq) && (frame.seqFrom === undefined || Number.isInteger(frame.seqFrom)) && isAgentEvent(frame.event) && frame.event.epoch === frame.epoch && frame.event.seq === frame.seq;
        case 'gap':
            return isCursor(frame.from) && isCursor(frame.resumeAt);
    }
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value)?.slice(0, 200) ?? String(value);
    } catch {
        return String(value);
    }
}

/**
 * A turn assembled from the local buffer, filtered by its turn id. One
 * collector drains the subscription into `own` (so `result` settles whether or
 * not anyone iterates); each iterator walks `own` by its own index and waits
 * for growth, so several consumers can iterate, and late ones see everything
 * once.
 *
 * Which turn is not known until the ack: a prompt sent while a turn runs on a
 * steering session lands IN that turn, and the ack names it. Events arriving
 * before the ack are staged and filtered once the target is known — a late
 * joiner that never saw the running turn's `turn-start` still gets a handle
 * with the right `id`, the right `result` and the events from its steer on.
 * "From the steer on" is the contract's own boundary: the `user-message` the
 * steer puts in the running turn, carrying the parts this client sent. The
 * local subscription started at the client's cursor, which can trail the
 * server, so what precedes that message is the running turn's past and is
 * dropped; a `turn-end` is never dropped, so `result` settles regardless.
 */
function createClientTurn(sessionId: string, turnId: string, sent: readonly PromptPart[], events: AsyncIterable<AgentEvent>, reply: Promise<WireReply>): AgentTurn {
    let target = turnId;
    let acked = false;
    /** `waiting`: a steer whose own `user-message` has not been seen yet. */
    let boundary: 'none' | 'waiting' | 'seen' = 'none';
    const staged: AgentEvent[] = [];
    let resolveResult!: (r: TurnResult) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<TurnResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    result.catch(() => {});
    const iterator = events[Symbol.asyncIterator]();
    const own: AgentEvent[] = [];
    let done = false;
    let failure: unknown;
    let wakers: (() => void)[] = [];
    const wake = () => {
        for (const w of wakers.splice(0)) w();
    };
    const changed = () =>
        new Promise<void>((resolve) => {
            wakers.push(resolve);
        });

    const finish = (e?: unknown) => {
        if (done) return;
        done = true;
        failure = e;
        void iterator.return?.();
        wake();
    };

    const accept = (e: AgentEvent) => {
        if (done || e.turnId !== target) return;
        if (boundary === 'waiting') {
            if (e.type === 'user-message' && e.parentCallId === undefined && sameParts(e.parts, sent)) boundary = 'seen';
            else if (e.type !== 'turn-end') return;
        }
        own.push(e);
        wake();
        if (e.type === 'turn-end') {
            const { type: _t, sessionId: _s, epoch: _e, seq: _q, turnId: _i, parentCallId: _p, ...payload } = e;
            resolveResult({ turnId: target, ...payload });
            finish();
        }
    };

    void reply.then(
        (r) => {
            if (r.kind === 'error') {
                const error = r.code === 'busy' ? new SessionBusyError(sessionId, turnId) : new RemoteCommandError('prompt', r.code, r.message);
                rejectResult(error);
                finish(error);
                return;
            }
            target = r.turnId ?? turnId;
            if (target !== turnId) boundary = 'waiting';
            acked = true;
            for (const e of staged.splice(0)) accept(e);
        },
        (e: unknown) => {
            rejectResult(e);
            finish(e);
        }
    );

    void (async () => {
        try {
            for (;;) {
                const next = await iterator.next();
                if (next.done) break;
                if (acked) accept(next.value);
                else staged.push(next.value);
                if (done) return;
            }
            if (!done) {
                const e = new AgentError('protocol_error', `[sigx ai-agent] the connection ended before turn "${target}" did`);
                rejectResult(e);
                finish(e);
            }
        } catch (e) {
            rejectResult(e);
            finish(e);
        }
    })();

    return {
        get id() {
            return target;
        },
        result,
        [Symbol.asyncIterator]() {
            let i = 0;
            let stopped = false;
            return {
                next: async (): Promise<IteratorResult<AgentEvent>> => {
                    for (;;) {
                        if (stopped) return { value: undefined as never, done: true };
                        if (i < own.length) return { value: own[i++]!, done: false };
                        if (done) {
                            if (failure !== undefined) throw failure;
                            return { value: undefined as never, done: true };
                        }
                        await changed();
                    }
                },
                return: (): Promise<IteratorResult<AgentEvent>> => {
                    stopped = true;
                    return Promise.resolve({ value: undefined as never, done: true });
                },
                [Symbol.asyncIterator]() {
                    return this;
                }
            };
        }
    };
}

/** The parts a steer sent, as the adapter echoes them on its `user-message` (plain JSON both ways). */
function sameParts(a: readonly PromptPart[], b: readonly PromptPart[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
    return true;
}

function failed(turnId: string, error: Error): AgentTurn {
    const result = Promise.reject(error);
    result.catch(() => {});
    return {
        id: turnId,
        result,
        [Symbol.asyncIterator]() {
            return {
                next: () => Promise.reject(error),
                return: () => Promise.resolve({ value: undefined, done: true as const }),
                [Symbol.asyncIterator]() {
                    return this;
                }
            };
        }
    };
}
