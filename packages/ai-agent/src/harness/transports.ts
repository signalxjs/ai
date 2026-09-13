/**
 * Transport helpers — a WebSocket as a pair of Web Streams, so a remote agent
 * behind a socket is driven by the same peer as one behind stdio (with
 * `framing: 'message'`: one frame, one document).
 */

/** The subset of the WHATWG WebSocket the bridge needs (browser, worker, Node ≥ 22, `ws`). */
export interface WebSocketLike {
    readonly readyState: number;
    binaryType?: string;
    send(data: string | ArrayBufferLike | Uint8Array): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'close', listener: (event: unknown) => void): void;
    addEventListener(type: 'error', listener: (event: unknown) => void): void;
    addEventListener(type: 'open', listener: (event: unknown) => void): void;
    /** Optional; when present the bridge removes its listeners once the socket closes. */
    removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface WebSocketStreams {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    /** Settles when the socket closes (or errors). */
    readonly closed: Promise<void>;
}

const CONNECTING = 0;
const OPEN = 1;

export function webSocketStreams(ws: WebSocketLike): WebSocketStreams {
    const encoder = new TextEncoder();
    if ('binaryType' in ws) ws.binaryType = 'arraybuffer';
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    const readable = new ReadableStream<Uint8Array>({
        start(controller) {
            let done = false;
            // Frames are enqueued strictly in arrival order: a Blob frame is read
            // asynchronously, so everything queues behind the previous frame's read.
            let chain: Promise<void> = Promise.resolve();
            const toBytes = async (data: unknown): Promise<Uint8Array | undefined> => {
                if (typeof data === 'string') return encoder.encode(data);
                if (data instanceof ArrayBuffer) return new Uint8Array(data);
                if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                if (data && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
                    return new Uint8Array(await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
                }
                return undefined;
            };
            const onMessage = (event: { data: unknown }) => {
                if (done) return;
                const { data } = event;
                chain = chain.then(async () => {
                    if (done) return;
                    try {
                        const bytes = await toBytes(data);
                        if (bytes && !done) controller.enqueue(bytes);
                    } catch (e) {
                        // A failed read cannot be skipped (framing would drift): the stream fails.
                        fail(e instanceof Error ? e : new Error(String(e)));
                    }
                });
            };
            const detach = () => {
                done = true;
                ws.removeEventListener?.('message', onMessage as (event: unknown) => void);
                ws.removeEventListener?.('close', finish);
                ws.removeEventListener?.('error', finish);
                resolveClosed();
            };
            const finish = () => {
                if (done) return;
                detach();
                try {
                    controller.close();
                } catch {
                    // already closed by cancel()
                }
            };
            const fail = (error: Error) => {
                if (done) return;
                detach();
                controller.error(error);
                ws.close();
            };
            ws.addEventListener('message', onMessage);
            ws.addEventListener('close', finish);
            ws.addEventListener('error', finish);
            // Already closing or closed: no close event will ever come — settle now.
            if (ws.readyState !== CONNECTING && ws.readyState !== OPEN) finish();
        },
        cancel() {
            ws.close();
        }
    });

    // Resolves once the socket is open — or at once when it is open already, or
    // closing/closed (no event will ever fire; the write then reports "not open").
    const ready =
        ws.readyState === CONNECTING
            ? new Promise<void>((resolve) => {
                  const settle = () => {
                      ws.removeEventListener?.('open', settle);
                      ws.removeEventListener?.('close', settle);
                      ws.removeEventListener?.('error', settle);
                      resolve();
                  };
                  ws.addEventListener('open', settle);
                  ws.addEventListener('close', settle);
                  ws.addEventListener('error', settle);
              })
            : Promise.resolve();

    const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
            await ready;
            if (ws.readyState !== OPEN) throw new Error('[sigx ai-agent] WebSocket is not open');
            ws.send(chunk);
        },
        close() {
            ws.close();
        },
        abort() {
            ws.close();
        }
    });

    return { readable, writable, closed };
}
