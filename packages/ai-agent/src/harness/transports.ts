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
    removeEventListener?(type: string, listener: (event: never) => void): void;
}

export interface WebSocketStreams {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    /** Settles when the socket closes (or errors). */
    readonly closed: Promise<void>;
}

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
            const finish = () => {
                if (done) return;
                done = true;
                try {
                    controller.close();
                } catch {
                    // already closed by cancel()
                }
                resolveClosed();
            };
            ws.addEventListener('message', (event) => {
                if (done) return;
                const data = event.data;
                if (typeof data === 'string') controller.enqueue(encoder.encode(data));
                else if (data instanceof ArrayBuffer) controller.enqueue(new Uint8Array(data));
                else if (ArrayBuffer.isView(data)) controller.enqueue(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                else if (data && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
                    void (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer().then((buf) => {
                        if (!done) controller.enqueue(new Uint8Array(buf));
                    });
                }
            });
            ws.addEventListener('close', finish);
            ws.addEventListener('error', finish);
        },
        cancel() {
            ws.close();
        }
    });

    const ready =
        ws.readyState === OPEN
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                  ws.addEventListener('open', () => resolve());
                  ws.addEventListener('close', () => resolve());
                  ws.addEventListener('error', () => resolve());
              });

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
