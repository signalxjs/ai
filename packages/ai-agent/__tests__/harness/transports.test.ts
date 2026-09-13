import { describe, it, expect } from 'vitest';
import { webSocketStreams, createJsonRpcPeer, type WebSocketLike } from '@sigx/ai-agent/harness';
import { tick } from '../helpers';

/** A fake WebSocket: `send` goes to `sent`, `receive` dispatches a message. */
function fakeSocket(readyState = 1) {
    const listeners = new Map<string, ((e: any) => void)[]>();
    const sent: unknown[] = [];
    const ws: WebSocketLike & { receive(data: unknown): void; open(): void; end(): void; readonly sent: unknown[]; readyState: number } = {
        readyState,
        binaryType: 'blob',
        sent,
        send: (d) => sent.push(d),
        close: () => {
            ws.readyState = 3;
            for (const l of listeners.get('close') ?? []) l({});
        },
        addEventListener: (type: string, l: (e: any) => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), l]);
        },
        receive: (data) => {
            for (const l of listeners.get('message') ?? []) l({ data });
        },
        open: () => {
            ws.readyState = 1;
            for (const l of listeners.get('open') ?? []) l({});
        },
        end: () => {
            for (const l of listeners.get('close') ?? []) l({});
        }
    };
    return ws;
}

describe('webSocketStreams', () => {
    it('turns text and binary messages into chunks and writes chunks as frames', async () => {
        const ws = fakeSocket();
        const { readable, writable, closed } = webSocketStreams(ws);
        expect(ws.binaryType).toBe('arraybuffer');
        const reader = readable.getReader();
        ws.receive('{"a":1}');
        ws.receive(new TextEncoder().encode('{"b":2}').buffer);
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"a":1}');
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"b":2}');
        const writer = writable.getWriter();
        await writer.write(new TextEncoder().encode('{"c":3}'));
        expect(ws.sent).toHaveLength(1);
        ws.end();
        expect((await reader.read()).done).toBe(true);
        await closed;
    });

    it('waits for open before writing; a closed socket rejects writes', async () => {
        const ws = fakeSocket(0);
        const { writable } = webSocketStreams(ws);
        const writer = writable.getWriter();
        const p = writer.write(new Uint8Array([1]));
        await tick();
        expect(ws.sent).toHaveLength(0);
        ws.open();
        await p;
        expect(ws.sent).toHaveLength(1);
        ws.close();
        await expect(writer.write(new Uint8Array([2]))).rejects.toThrow(/not open/);
    });

    it('drives a JSON-RPC peer with message framing', async () => {
        const ws = fakeSocket();
        const streams = webSocketStreams(ws);
        const peer = createJsonRpcPeer({ ...streams, framing: 'message' });
        const p = peer.request('hello', { n: 1 });
        await tick();
        const frame = JSON.parse(new TextDecoder().decode(ws.sent[0] as Uint8Array));
        expect(frame).toEqual({ jsonrpc: '2.0', id: 1, method: 'hello', params: { n: 1 } });
        ws.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'world' }));
        expect(await p).toBe('world');
        await peer.close();
    });
});
