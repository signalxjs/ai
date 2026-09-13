import { describe, it, expect } from 'vitest';
import { createJsonRpcPeer, JsonRpcError, JsonRpcClosedError, JsonRpcAbortError, JSON_RPC, type JsonRpcPeer, type JsonRpcProtocolError } from '@sigx/ai-agent/harness';
import { tick } from '../helpers';

/** Two peers wired back to back over TransformStreams. */
function pair(options: { framing?: 'ndjson' | 'message'; cancelMethod?: string | null; highWaterMark?: number } = {}) {
    const strategy = options.highWaterMark !== undefined ? { highWaterMark: options.highWaterMark } : undefined;
    const aToB = new TransformStream<Uint8Array, Uint8Array>({}, strategy, strategy);
    const bToA = new TransformStream<Uint8Array, Uint8Array>({}, strategy, strategy);
    const errorsA: JsonRpcProtocolError[] = [];
    const errorsB: JsonRpcProtocolError[] = [];
    const a = createJsonRpcPeer({ readable: bToA.readable, writable: aToB.writable, framing: options.framing, cancelMethod: options.cancelMethod, onProtocolError: (e) => errorsA.push(e) });
    const b = createJsonRpcPeer({ readable: aToB.readable, writable: bToA.writable, framing: options.framing, cancelMethod: options.cancelMethod, onProtocolError: (e) => errorsB.push(e) });
    return { a, b, errorsA, errorsB, aToB, bToA };
}

/** A raw byte writer into a peer, for malformed input. */
function rawPeer() {
    const inbound = new TransformStream<Uint8Array, Uint8Array>();
    const outbound = new TransformStream<Uint8Array, Uint8Array>();
    const errors: JsonRpcProtocolError[] = [];
    const peer = createJsonRpcPeer({ readable: inbound.readable, writable: outbound.writable, onProtocolError: (e) => errors.push(e) });
    const writer = inbound.writable.getWriter();
    const outLines: string[] = [];
    void (async () => {
        let buffer = '';
        for await (const chunk of outbound.readable) {
            buffer += new TextDecoder().decode(chunk);
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
                outLines.push(buffer.slice(0, i));
                buffer = buffer.slice(i + 1);
            }
        }
    })();
    return { peer, errors, write: (s: string) => writer.write(new TextEncoder().encode(s)), close: () => writer.close(), outLines };
}

describe('createJsonRpcPeer', () => {
    it('requests in both directions, with params and results', async () => {
        const { a, b } = pair();
        b.onRequest<{ x: number }>('double', (p) => p.x * 2);
        a.onRequest('name', () => 'a');
        expect(await a.request('double', { x: 21 })).toBe(42);
        expect(await b.request('name')).toBe('a');
        await a.close();
        await b.close();
    });

    it('correlates out-of-order responses and undefined results become null', async () => {
        const { a, b } = pair();
        b.onRequest<{ ms: number; v: string }>('slow', async (p) => {
            await tick(p.ms);
            return p.v;
        });
        b.onRequest('nothing', () => undefined);
        const [slow, fast, nothing] = await Promise.all([a.request('slow', { ms: 20, v: 'slow' }), a.request('slow', { ms: 1, v: 'fast' }), a.request('nothing')]);
        expect([slow, fast, nothing]).toEqual(['slow', 'fast', null]);
        await a.close();
    });

    it('notifications reach handlers; unknown ones reach onUnhandled; unknown methods get -32601', async () => {
        const { a, b } = pair();
        const seen: unknown[] = [];
        const other: unknown[] = [];
        b.onNotification('ping', (p) => seen.push(p));
        b.onUnhandled((m) => other.push(m));
        await a.notify('ping', { n: 1 });
        await a.notify('mystery', { n: 2 });
        await expect(a.request('nope')).rejects.toMatchObject({ code: JSON_RPC.METHOD_NOT_FOUND });
        await tick();
        expect(seen).toEqual([{ n: 1 }]);
        expect(other).toEqual([{ method: 'mystery', params: { n: 2 } }, { method: 'nope', params: undefined, id: 1 }]);
        await a.close();
    });

    it('handler errors travel as JsonRpcError; JsonRpcError keeps its code and data', async () => {
        const { a, b } = pair();
        b.onRequest('boom', () => {
            throw new Error('kaboom');
        });
        b.onRequest('typed', () => {
            throw new JsonRpcError(-32001, 'custom', { why: 'because' });
        });
        await expect(a.request('boom')).rejects.toMatchObject({ code: JSON_RPC.INTERNAL_ERROR, message: 'kaboom' });
        const e = await a.request('typed').catch((x: unknown) => x);
        expect(e).toBeInstanceOf(JsonRpcError);
        expect(e).toMatchObject({ code: -32001, message: 'custom', data: { why: 'because' } });
        await a.close();
    });

    it('closing rejects pending requests with JsonRpcClosedError and settles closed', async () => {
        const { a, b } = pair();
        b.onRequest('hang', () => new Promise(() => {}));
        const p = a.request('hang');
        await tick();
        await a.close();
        await expect(p).rejects.toBeInstanceOf(JsonRpcClosedError);
        expect((await a.closed).reason).toBe('closed');
        await expect(a.request('x')).rejects.toBeInstanceOf(JsonRpcClosedError);
        // The other side sees EOF.
        expect((await b.closed).reason).toBe('eof');
    });

    it('aborting a request sends the cancel notification, rejects locally, and ignores the late response', async () => {
        const { a, b, errorsA } = pair();
        const cancels: unknown[] = [];
        b.onNotification('$/cancel_request', (p) => cancels.push(p));
        let release!: () => void;
        b.onRequest('slow', () => new Promise((r) => (release = () => r('late'))));
        const ctrl = new AbortController();
        const p = a.request('slow', undefined, { signal: ctrl.signal });
        await tick();
        ctrl.abort();
        await expect(p).rejects.toBeInstanceOf(JsonRpcAbortError);
        await tick();
        expect(cancels).toEqual([{ requestId: 1 }]);
        release();
        await tick(5);
        expect(errorsA).toHaveLength(1);
        expect(errorsA[0]!.message).toMatch(/unknown request id 1/);
        await a.close();
    });

    it('a request with an already-aborted signal rejects and writes nothing', async () => {
        const raw = rawPeer();
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(raw.peer.request('never', { x: 1 }, { signal: ctrl.signal })).rejects.toBeInstanceOf(JsonRpcAbortError);
        await tick(5);
        expect(raw.outLines).toEqual([]);
        await raw.close();
    });

    it('cancelMethod: null sends nothing; a custom method and params are honoured', async () => {
        const quiet = pair({ cancelMethod: null });
        const seen: unknown[] = [];
        quiet.b.onUnhandled((m) => seen.push(m));
        quiet.b.onRequest('hang', () => new Promise(() => {}));
        const ctrl = new AbortController();
        const p = quiet.a.request('hang', undefined, { signal: ctrl.signal });
        await tick();
        ctrl.abort();
        await expect(p).rejects.toBeInstanceOf(JsonRpcAbortError);
        await tick();
        expect(seen).toEqual([]);
        await quiet.a.close();

        const inbound = new TransformStream<Uint8Array, Uint8Array>();
        const outbound = new TransformStream<Uint8Array, Uint8Array>();
        const x = createJsonRpcPeer({ readable: inbound.readable, writable: outbound.writable, cancelMethod: 'cancel', cancelParams: (id) => ({ id, reason: 'user' }) });
        const y = createJsonRpcPeer({ readable: outbound.readable, writable: inbound.writable, cancelMethod: 'cancel' });
        const got: unknown[] = [];
        y.onNotification('cancel', (p) => got.push(p));
        y.onRequest('hang', () => new Promise(() => {}));
        const c2 = new AbortController();
        const p2 = x.request('hang', undefined, { signal: c2.signal });
        await tick();
        c2.abort();
        await p2.catch(() => {});
        await tick();
        expect(got).toEqual([{ id: 1, reason: 'user' }]);
        await x.close();
    });

    it('an incoming cancel aborts the handler signal and the response is still sent', async () => {
        const { a, b } = pair();
        let aborted = false;
        b.onRequest('work', (_p, ctx) =>
            new Promise((resolve) => {
                ctx.signal.addEventListener('abort', () => {
                    aborted = true;
                    resolve('cancelled-result');
                });
            })
        );
        const p = a.request('work');
        await tick();
        await a.notify('$/cancel_request', { requestId: 1 });
        expect(await p).toBe('cancelled-result');
        expect(aborted).toBe(true);
        await a.close();
    });

    it('a message without jsonrpc 2.0 is answered -32600 when request-shaped, reported otherwise', async () => {
        const raw = rawPeer();
        raw.peer.onRequest('echo', (p) => p);
        await raw.write('{"id":5,"method":"echo"}\n');
        await raw.write('{"method":"echo"}\n');
        await raw.write('{"jsonrpc":"1.0","id":6,"result":1}\n');
        await raw.write('{"jsonrpc":"2.0","id":7,"method":"echo","params":1}\n');
        await tick(5);
        expect(raw.outLines.map((l) => JSON.parse(l))).toEqual([
            { jsonrpc: '2.0', id: 5, error: { code: JSON_RPC.INVALID_REQUEST, message: 'Not a JSON-RPC 2.0 message' } },
            { jsonrpc: '2.0', id: 7, result: 1 }
        ]);
        expect(raw.errors.map((e) => e.code)).toEqual([JSON_RPC.INVALID_REQUEST, JSON_RPC.INVALID_REQUEST]);
        await raw.close();
    });

    it('timeoutMs rejects with REQUEST_CANCELLED and cancels the peer request', async () => {
        const { a, b } = pair();
        const cancels: unknown[] = [];
        b.onNotification('$/cancel_request', (p) => cancels.push(p));
        b.onRequest('hang', () => new Promise(() => {}));
        await expect(a.request('hang', undefined, { timeoutMs: 10 })).rejects.toMatchObject({ code: JSON_RPC.REQUEST_CANCELLED });
        await tick();
        expect(cancels).toEqual([{ requestId: 1 }]);
        await a.close();
    });

    it('a batch is refused with -32600; invalid JSON is reported and the peer keeps working', async () => {
        const raw = rawPeer();
        raw.peer.onRequest('echo', (p) => p);
        await raw.write('[{"jsonrpc":"2.0","id":1,"method":"echo"}]\n');
        await raw.write('{not json\n');
        await raw.write('42\n');
        await raw.write('{"jsonrpc":"2.0","id":"r1","method":"echo","params":{"ok":true}}\n');
        await tick(5);
        expect(raw.outLines.map((l) => JSON.parse(l))).toEqual([
            { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.INVALID_REQUEST, message: 'Batch requests are not supported' } },
            { jsonrpc: '2.0', id: 'r1', result: { ok: true } }
        ]);
        expect(raw.errors.map((e) => e.code)).toEqual([JSON_RPC.PARSE_ERROR, JSON_RPC.INVALID_REQUEST]);
        expect(raw.errors[0]!.raw).toBe('{not json');
        await raw.close();
        expect((await raw.peer.closed).reason).toBe('eof');
    });

    it('delivers a storm of notifications through a slow reader without loss (backpressure)', async () => {
        const { a, b } = pair({ highWaterMark: 1 });
        let received = 0;
        let last = -1;
        b.onNotification<{ i: number }>('tick', (p) => {
            expect(p.i).toBe(last + 1);
            last = p.i;
            received++;
        });
        const N = 5000;
        const sends: Promise<void>[] = [];
        for (let i = 0; i < N; i++) sends.push(a.notify('tick', { i }));
        await Promise.all(sends);
        // Round trip a request to know everything before it was processed.
        b.onRequest('flush', () => received);
        expect(await a.request('flush')).toBe(N);
        await a.close();
    });

    it('message framing works over one-document-per-chunk transports', async () => {
        const { a, b } = pair({ framing: 'message' });
        b.onRequest('hi', () => 'there');
        expect(await a.request('hi')).toBe('there');
        await a.close();
    });

    it('a stream failure (oversized line) settles closed with reason error', async () => {
        const inbound = new TransformStream<Uint8Array, Uint8Array>();
        const outbound = new TransformStream<Uint8Array, Uint8Array>();
        const errors: JsonRpcProtocolError[] = [];
        const peer: JsonRpcPeer = createJsonRpcPeer({ readable: inbound.readable, writable: outbound.writable, maxLineBytes: 16, onProtocolError: (e) => errors.push(e) });
        void outbound.readable.pipeTo(new WritableStream());
        const w = inbound.writable.getWriter();
        await w.write(new TextEncoder().encode('x'.repeat(40)));
        const state = await peer.closed;
        expect(state.reason).toBe('error');
        expect(state.error?.name).toBe('LineTooLongError');
        expect(errors.at(-1)?.message).toMatch(/exceeds 16 bytes/);
    });

    it('unsubscribe functions remove handlers', async () => {
        const { a, b } = pair();
        const off = b.onRequest('once', () => 1);
        expect(await a.request('once')).toBe(1);
        off();
        await expect(a.request('once')).rejects.toMatchObject({ code: JSON_RPC.METHOD_NOT_FOUND });
        await a.close();
    });
});
