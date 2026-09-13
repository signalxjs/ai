/**
 * A JSON-RPC 2.0 peer over Web Streams — requests in both directions, which
 * is what every agent protocol needs (an agent asks the client for a
 * permission while the client waits for the prompt to finish).
 *
 * Cancellation is cooperative: aborting a request sends the protocol's cancel
 * notification and settles locally; the peer's late response is then ignored.
 * An incoming cancel aborts the handler's signal but the handler's result is
 * still sent — the protocols we speak expect a response even after a cancel.
 * Writes go through one serialized writer that honours backpressure.
 */

import { LineTooLongError, messageDecoder, messageEncoder, ndjsonDecoder, ndjsonEncoder, type Framing } from './framing.js';

export type JsonRpcId = string | number;

export const JSON_RPC = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    REQUEST_CANCELLED: -32800
} as const;

/** An error the peer sent back, or one a handler throws to send back. */
export class JsonRpcError extends Error {
    override readonly name = 'JsonRpcError';
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
    }
}

/** The connection closed while a request was pending. */
export class JsonRpcClosedError extends Error {
    override readonly name = 'JsonRpcClosedError';
    constructor(readonly method: string) {
        super(`[sigx ai-agent] JSON-RPC connection closed while "${method}" was pending`);
    }
}

/** The caller's signal aborted a pending request. */
export class JsonRpcAbortError extends Error {
    override readonly name = 'JsonRpcAbortError';
    constructor(readonly method: string) {
        super(`[sigx ai-agent] JSON-RPC request "${method}" was aborted`);
    }
}

/** What arrived that the peer could not act on. */
export interface JsonRpcProtocolError {
    readonly code: number;
    readonly message: string;
    /** The raw line, when there was one. */
    readonly raw?: string;
}

export interface JsonRpcPeerOptions {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    /** Default `'ndjson'`. */
    readonly framing?: Framing;
    readonly maxLineBytes?: number;
    /** Notification sent when a caller aborts a request; `null` for protocols without one. Default `$/cancel_request`. */
    readonly cancelMethod?: string | null;
    /** Its params; default `{ requestId: id }`. */
    readonly cancelParams?: (id: JsonRpcId) => unknown;
    readonly onProtocolError?: (error: JsonRpcProtocolError) => void;
}

export interface RequestContext {
    readonly id: JsonRpcId;
    readonly method: string;
    /** Aborts when the peer cancels the request or the connection closes. */
    readonly signal: AbortSignal;
}

export type RequestHandler<P = unknown, R = unknown> = (params: P, ctx: RequestContext) => R | Promise<R>;
export type NotificationHandler<P = unknown> = (params: P) => void;

export interface UnhandledMessage {
    readonly method: string;
    readonly params?: unknown;
    readonly id?: JsonRpcId;
}

export interface JsonRpcPeer {
    request<R = unknown>(method: string, params?: unknown, options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<R>;
    /** Resolves once the bytes are written. */
    notify(method: string, params?: unknown): Promise<void>;
    /** Returns the unsubscribe function. */
    onRequest<P = unknown, R = unknown>(method: string, handler: RequestHandler<P, R>): () => void;
    onNotification<P = unknown>(method: string, handler: NotificationHandler<P>): () => void;
    /** Notifications (and requests, already answered with -32601) nobody handles. */
    onUnhandled(handler: (message: UnhandledMessage) => void): () => void;
    readonly closed: Promise<{ readonly reason: 'eof' | 'closed' | 'error'; readonly error?: Error }>;
    close(error?: Error): Promise<void>;
}

interface Pending {
    readonly method: string;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    cleanup(): void;
}

const isId = (v: unknown): v is JsonRpcId => typeof v === 'string' || typeof v === 'number';

export function createJsonRpcPeer(options: JsonRpcPeerOptions): JsonRpcPeer {
    const framing = options.framing ?? 'ndjson';
    const cancelMethod = options.cancelMethod === undefined ? '$/cancel_request' : options.cancelMethod;
    const cancelParams = options.cancelParams ?? ((id: JsonRpcId) => ({ requestId: id }));

    const pending = new Map<JsonRpcId, Pending>();
    const inflight = new Map<JsonRpcId, AbortController>();
    const requestHandlers = new Map<string, RequestHandler>();
    const notificationHandlers = new Map<string, NotificationHandler>();
    const unhandled = new Set<(m: UnhandledMessage) => void>();
    let nextId = 0;
    let closedState: { reason: 'eof' | 'closed' | 'error'; error?: Error } | undefined;
    let resolveClosed!: (v: { reason: 'eof' | 'closed' | 'error'; error?: Error }) => void;
    const closed = new Promise<{ reason: 'eof' | 'closed' | 'error'; error?: Error }>((resolve) => {
        resolveClosed = resolve;
    });

    // One writer, one queue: writes never interleave and each awaits `ready`.
    const encoder = framing === 'ndjson' ? ndjsonEncoder() : messageEncoder();
    const encoded = encoder.readable.pipeTo(options.writable).catch(() => {});
    const writer = encoder.writable.getWriter();
    let writeChain: Promise<void> = Promise.resolve();
    const send = (message: unknown): Promise<void> => {
        if (closedState) return Promise.resolve();
        const p = writeChain.then(async () => {
            if (closedState) return;
            await writer.ready;
            await writer.write(message);
        });
        writeChain = p.catch(() => {});
        return p;
    };

    const protocolError = (code: number, message: string, raw?: string) => {
        options.onProtocolError?.({ code, message, ...(raw !== undefined ? { raw } : {}) });
    };

    const finish = (state: { reason: 'eof' | 'closed' | 'error'; error?: Error }) => {
        if (closedState) return;
        closedState = state;
        for (const [id, p] of pending) {
            pending.delete(id);
            p.cleanup();
            p.reject(new JsonRpcClosedError(p.method));
        }
        for (const [, c] of inflight) c.abort();
        inflight.clear();
        writer.close().catch(() => {});
        resolveClosed(state);
    };

    const respond = (id: JsonRpcId | null, body: { result: unknown } | { error: { code: number; message: string; data?: unknown } }) =>
        send({ jsonrpc: '2.0', id, ...body });

    const handleRequest = async (id: JsonRpcId, method: string, params: unknown) => {
        const handler = requestHandlers.get(method);
        if (!handler) {
            for (const h of unhandled) h({ method, params, id });
            await respond(id, { error: { code: JSON_RPC.METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
            return;
        }
        const controller = new AbortController();
        inflight.set(id, controller);
        try {
            const result = await handler(params, { id, method, signal: controller.signal });
            await respond(id, { result: result === undefined ? null : result });
        } catch (e) {
            const error =
                e instanceof JsonRpcError
                    ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) }
                    : { code: JSON_RPC.INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) };
            await respond(id, { error });
        } finally {
            inflight.delete(id);
        }
    };

    const handleMessage = (line: string) => {
        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch (e) {
            protocolError(JSON_RPC.PARSE_ERROR, e instanceof Error ? e.message : String(e), line);
            return;
        }
        if (Array.isArray(message)) {
            void respond(null, { error: { code: JSON_RPC.INVALID_REQUEST, message: 'Batch requests are not supported' } });
            return;
        }
        if (typeof message !== 'object' || message === null) {
            protocolError(JSON_RPC.INVALID_REQUEST, 'Not a JSON-RPC message', line);
            return;
        }
        const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
        if (m.jsonrpc !== '2.0') {
            // Not JSON-RPC 2.0: answer anything request-shaped so its sender never waits
            // (a malformed id is echoed as null, as the spec requires); report the rest.
            if (typeof m.method === 'string') void respond(isId(m.id) ? m.id : null, { error: { code: JSON_RPC.INVALID_REQUEST, message: 'Not a JSON-RPC 2.0 message' } });
            else protocolError(JSON_RPC.INVALID_REQUEST, 'Not a JSON-RPC 2.0 message', line);
            return;
        }
        if (typeof m.method === 'string') {
            if (isId(m.id)) {
                void handleRequest(m.id, m.method, m.params);
                return;
            }
            if ('id' in m && m.id !== undefined) {
                // An id of the wrong type is a malformed request, answered so the caller never hangs.
                void respond(null, { error: { code: JSON_RPC.INVALID_REQUEST, message: 'Invalid request id' } });
                return;
            }
            if (cancelMethod !== null && m.method === cancelMethod) {
                const target = (m.params as { requestId?: unknown } | undefined)?.requestId;
                if (isId(target)) inflight.get(target)?.abort();
            }
            const handler = notificationHandlers.get(m.method);
            if (handler) handler(m.params);
            else for (const h of unhandled) h({ method: m.method, params: m.params });
            return;
        }
        if (isId(m.id)) {
            const p = pending.get(m.id);
            if (!p) {
                protocolError(JSON_RPC.INVALID_REQUEST, `Response for unknown request id ${String(m.id)}`, line);
                return;
            }
            pending.delete(m.id);
            p.cleanup();
            if (m.error !== undefined) {
                const err = (m.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
                p.reject(new JsonRpcError(typeof err.code === 'number' ? err.code : JSON_RPC.INTERNAL_ERROR, typeof err.message === 'string' ? err.message : 'Unknown error', err.data));
            } else p.resolve(m.result);
            return;
        }
        protocolError(JSON_RPC.INVALID_REQUEST, 'Not a JSON-RPC message', line);
    };

    // The read loop: decode frames, dispatch, and settle `closed` on EOF or failure.
    const decoder = framing === 'ndjson' ? ndjsonDecoder(options.maxLineBytes !== undefined ? { maxLineBytes: options.maxLineBytes } : {}) : messageDecoder();
    const reader = options.readable.pipeThrough(decoder).getReader();
    void (async () => {
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                handleMessage(value);
            }
            finish({ reason: 'eof' });
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            // A stream failure is not a parse error: an oversized frame is an invalid
            // request, anything else is an internal (transport) failure.
            protocolError(error instanceof LineTooLongError ? JSON_RPC.INVALID_REQUEST : JSON_RPC.INTERNAL_ERROR, error.message);
            finish({ reason: closedState ? closedState.reason : 'error', error });
        }
    })();

    const peer: JsonRpcPeer = {
        request<R>(method: string, params?: unknown, reqOptions: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<R> {
            if (closedState) return Promise.reject(new JsonRpcClosedError(method));
            // Already aborted: nothing goes on the wire — no request, no cancel for it.
            if (reqOptions.signal?.aborted) return Promise.reject(new JsonRpcAbortError(method));
            const id = ++nextId;
            return new Promise<R>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const onAbort = () => {
                    if (!pending.has(id)) return;
                    pending.delete(id);
                    cleanup();
                    if (cancelMethod !== null) void send({ jsonrpc: '2.0', method: cancelMethod, params: cancelParams(id) });
                    reject(new JsonRpcAbortError(method));
                };
                const cleanup = () => {
                    if (timer !== undefined) clearTimeout(timer);
                    reqOptions.signal?.removeEventListener('abort', onAbort);
                };
                pending.set(id, { method, resolve: (v) => resolve(v as R), reject, cleanup });
                reqOptions.signal?.addEventListener('abort', onAbort, { once: true });
                if (reqOptions.timeoutMs !== undefined) {
                    timer = setTimeout(() => {
                        if (!pending.has(id)) return;
                        pending.delete(id);
                        cleanup();
                        if (cancelMethod !== null) void send({ jsonrpc: '2.0', method: cancelMethod, params: cancelParams(id) });
                        reject(new JsonRpcError(JSON_RPC.REQUEST_CANCELLED, `[sigx ai-agent] JSON-RPC request "${method}" timed out after ${reqOptions.timeoutMs} ms`));
                    }, reqOptions.timeoutMs);
                }
                void send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }).catch((e: unknown) => {
                    if (!pending.has(id)) return;
                    pending.delete(id);
                    cleanup();
                    reject(e instanceof Error ? e : new Error(String(e)));
                });
            });
        },
        notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
        onRequest(method, handler) {
            requestHandlers.set(method, handler as RequestHandler);
            return () => {
                if (requestHandlers.get(method) === handler) requestHandlers.delete(method);
            };
        },
        onNotification(method, handler) {
            notificationHandlers.set(method, handler as NotificationHandler);
            return () => {
                if (notificationHandlers.get(method) === handler) notificationHandlers.delete(method);
            };
        },
        onUnhandled(handler) {
            unhandled.add(handler);
            return () => {
                unhandled.delete(handler);
            };
        },
        closed,
        async close(error) {
            finish(error ? { reason: 'error', error } : { reason: 'closed' });
            await reader.cancel().catch(() => {});
            await encoded;
        }
    };
    return peer;
}
