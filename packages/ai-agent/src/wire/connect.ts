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

import type { AgentCapabilities, AgentEvent, Decision, PromptInput } from '../protocol/index.js';
import { AgentError, SessionBusyError, toPromptParts } from '../protocol/index.js';
import type { AgentSession, AgentTurn, PromptOptions, SessionRef, TurnResult } from '../session/index.js';
import { generateId } from '../utils/id.js';
import { cursorBefore, WIRE_PROTOCOL_VERSION, type Cursor, type WireCommand, type WireCommandPayload, type WireFrame, type WireReply } from './envelope.js';
import { createReplayBuffer } from './replay-buffer.js';

/** How commands and frames travel — the app's transport, as two functions. */
export interface SessionTransport {
    send(command: WireCommand): Promise<WireReply>;
    events(from?: Cursor, options?: { readonly signal?: AbortSignal }): AsyncIterable<WireFrame>;
}

export interface ReconnectOptions {
    /** Consecutive failed attempts before giving up. Default 5. */
    readonly maxAttempts?: number;
    /** Delay before attempt `n` (1-based). Default `100 * n` ms. */
    readonly backoffMs?: (attempt: number) => number;
}

export interface ConnectOptions {
    /** `false`: a broken stream ends the client. Default: reconnect with backoff. */
    readonly reconnect?: false | ReconnectOptions;
    /** Start from this cursor (a late joiner replaying history); default: live from now. */
    readonly from?: Cursor;
    readonly newId?: () => string;
    /** Local replay buffer size. Default 2000. */
    readonly bufferSize?: number;
}

export interface AgentSessionClient extends AgentSession {
    readonly agentId: string;
    readonly capabilities: AgentCapabilities;
    readonly connected: boolean;
    /** The last remote `(epoch, seq)` seen. */
    readonly cursor: Cursor | undefined;
    /** Stop following events without closing the remote session. */
    disconnect(): void;
}

const V = WIRE_PROTOCOL_VERSION;

export async function connectSession(transport: SessionTransport, options: ConnectOptions = {}): Promise<AgentSessionClient> {
    const newId = options.newId ?? (() => generateId('cmd'));
    const buffer = createReplayBuffer(options.bufferSize !== undefined ? { size: options.bufferSize } : {});
    const reconnect = options.reconnect === false ? undefined : { maxAttempts: options.reconnect?.maxAttempts ?? 5, backoffMs: options.reconnect?.backoffMs ?? ((n: number) => 100 * n) };

    let hello: Extract<WireFrame, { kind: 'hello' }> | undefined;
    let last: Cursor | undefined = options.from;
    let connected = false;
    let stopped = false;
    let controller = new AbortController();
    let resolveHello!: (h: Extract<WireFrame, { kind: 'hello' }>) => void;
    let rejectHello!: (e: unknown) => void;
    const firstHello = new Promise<Extract<WireFrame, { kind: 'hello' }>>((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
    });

    const apply = (frame: WireFrame) => {
        switch (frame.kind) {
            case 'hello':
                hello = frame;
                resolveHello(frame);
                break;
            case 'event': {
                const cursor = { epoch: frame.epoch, seq: frame.seq };
                if (last && !cursorBefore(last, cursor)) return;
                buffer.push(frame.event);
                last = cursor;
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
        while (!stopped) {
            controller = new AbortController();
            try {
                for await (const frame of transport.events(last, { signal: controller.signal })) {
                    if (stopped) break;
                    connected = true;
                    attempt = 0;
                    apply(frame);
                }
            } catch (e) {
                if (!hello) {
                    rejectHello(e);
                    return;
                }
            }
            connected = false;
            if (stopped || !reconnect) break;
            attempt++;
            if (attempt > reconnect.maxAttempts) break;
            await new Promise((r) => setTimeout(r, reconnect.backoffMs(attempt)));
        }
        buffer.close();
    };
    void follow();
    const first = await firstHello;

    const send = async (payload: WireCommandPayload): Promise<WireReply> => transport.send({ v: V, commandId: newId(), ...payload } as WireCommand);
    const sendOrThrow = async (payload: WireCommandPayload): Promise<void> => {
        const reply = await send(payload);
        if (reply.kind === 'error') throw new AgentError('protocol_error', `[sigx ai-agent] remote ${payload.type} failed (${reply.code}): ${reply.message}`);
    };

    const client: AgentSessionClient = {
        id: first.sessionId,
        agentId: first.agentId,
        capabilities: first.capabilities,
        get ref(): SessionRef {
            return hello?.sessionRef ?? first.sessionRef;
        },
        get connected() {
            return connected;
        },
        get cursor() {
            return last;
        },
        prompt(input: PromptInput, promptOptions?: PromptOptions) {
            const turnId = promptOptions?.turnId ?? newId();
            const from = last;
            const output = promptOptions?.output ? { schema: promptOptions.output.schema as Record<string, unknown>, ...(promptOptions.output.name !== undefined ? { name: promptOptions.output.name } : {}) } : undefined;
            if (output && '~standard' in output.schema) {
                return failed(turnId, new AgentError('protocol_error', '[sigx ai-agent] a remote prompt needs a JSON Schema for output; a Standard Schema cannot cross the wire'));
            }
            const reply = send({ type: 'prompt', turnId, input: toPromptParts(input), ...(output ? { output } : {}) });
            return createClientTurn(first.sessionId, turnId, buffer.subscribe(from), reply);
        },
        respond: (requestId: string, decision: Decision) => sendOrThrow({ type: 'respond', requestId, decision }),
        cancel: () => sendOrThrow({ type: 'cancel' }),
        ...(first.capabilities.config ? { configure: (patch: Readonly<Record<string, string>>) => sendOrThrow({ type: 'configure', patch }) } : {}),
        subscribe: (from) => buffer.subscribe(from),
        disconnect() {
            stopped = true;
            connected = false;
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

/**
 * A turn assembled from the local buffer, filtered by `turnId`. One collector
 * drains the subscription into `own` (so `result` settles whether or not
 * anyone iterates); each iterator walks `own` by its own index and waits for
 * growth, so several consumers can iterate, and late ones see everything once.
 */
function createClientTurn(sessionId: string, turnId: string, events: AsyncIterable<AgentEvent>, reply: Promise<WireReply>): AgentTurn {
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

    void reply.then(
        (r) => {
            if (r.kind === 'error') {
                const error = r.code === 'busy' ? new SessionBusyError(sessionId, turnId) : new AgentError('protocol_error', `[sigx ai-agent] remote prompt failed (${r.code}): ${r.message}`);
                rejectResult(error);
                finish(error);
            }
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
                const e = next.value;
                if (e.turnId !== turnId) continue;
                own.push(e);
                wake();
                if (e.type === 'turn-end') {
                    const { type: _t, sessionId: _s, epoch: _e, seq: _q, turnId: _i, parentCallId: _p, raw: _r, ...payload } = e;
                    resolveResult({ turnId, ...payload });
                    finish();
                    return;
                }
            }
            if (!done) {
                const e = new AgentError('protocol_error', `[sigx ai-agent] the connection ended before turn "${turnId}" did`);
                rejectResult(e);
                finish(e);
            }
        } catch (e) {
            rejectResult(e);
            finish(e);
        }
    })();

    return {
        id: turnId,
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
