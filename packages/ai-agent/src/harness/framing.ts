/**
 * Framing — how JSON documents are cut out of a byte stream.
 *
 * NDJSON splits on `0x0A` at the BYTE level, before decoding: a multi-byte
 * UTF-8 sequence never contains a newline byte, so chunk boundaries inside a
 * character or inside `\r\n` need no special handling. A trailing `\r` is
 * dropped, whitespace-only lines are skipped, and a line over `maxLineBytes`
 * errors the stream — a truncated frame cannot be resynced safely.
 *
 * `'message'` framing is for transports that already deliver one document
 * per chunk (WebSocket frames).
 */

export type Framing = 'ndjson' | 'message';

export interface NdjsonOptions {
    /** Bytes a single line may hold before the stream errors. Default 16 MiB. */
    readonly maxLineBytes?: number;
}

/** The stream error for a line over `maxLineBytes`. */
export class LineTooLongError extends Error {
    override readonly name = 'LineTooLongError';
    constructor(readonly bytes: number, limit: number) {
        super(`[sigx ai-agent] NDJSON line exceeds ${limit} bytes (${bytes} buffered); the stream cannot be resynced`);
    }
}

const DEFAULT_MAX_LINE = 16 * 1024 * 1024;
const NEWLINE = 0x0a;
const CR = 0x0d;

/** Bytes in → one decoded line (without its newline) per chunk out. */
export function ndjsonDecoder(options: NdjsonOptions = {}): TransformStream<Uint8Array, string> {
    const limit = options.maxLineBytes ?? DEFAULT_MAX_LINE;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;

    const flushLine = (last: Uint8Array, controller: TransformStreamDefaultController<string>) => {
        const parts = pending.length ? [...pending, last] : [last];
        pending = [];
        pendingBytes = 0;
        let total = 0;
        for (const p of parts) total += p.length;
        let bytes: Uint8Array;
        if (parts.length === 1) bytes = parts[0]!;
        else {
            bytes = new Uint8Array(total);
            let offset = 0;
            for (const p of parts) {
                bytes.set(p, offset);
                offset += p.length;
            }
        }
        if (bytes.length && bytes[bytes.length - 1] === CR) bytes = bytes.subarray(0, bytes.length - 1);
        const line = new TextDecoder().decode(bytes);
        if (line.trim().length) controller.enqueue(line);
    };

    return new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
            let start = 0;
            for (let i = 0; i < chunk.length; i++) {
                if (chunk[i] !== NEWLINE) continue;
                flushLine(chunk.subarray(start, i), controller);
                start = i + 1;
            }
            if (start < chunk.length) {
                const rest = chunk.subarray(start);
                pendingBytes += rest.length;
                if (pendingBytes > limit) {
                    const error = new LineTooLongError(pendingBytes, limit);
                    pending = [];
                    pendingBytes = 0;
                    controller.error(error);
                    return;
                }
                pending.push(rest);
            }
        },
        flush(controller) {
            // A final line without a newline still counts.
            if (pendingBytes) flushLine(new Uint8Array(0), controller);
        }
    });
}

/** One value in → its JSON plus a newline out. */
export function ndjsonEncoder(): TransformStream<unknown, Uint8Array> {
    const encoder = new TextEncoder();
    return new TransformStream<unknown, Uint8Array>({
        transform(value, controller) {
            controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
        }
    });
}

/** Bytes in (one document per chunk) → the decoded text per chunk out. */
export function messageDecoder(): TransformStream<Uint8Array, string> {
    return new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
            const text = new TextDecoder().decode(chunk);
            if (text.trim().length) controller.enqueue(text);
        }
    });
}

/** One value in → its JSON as one chunk out (no newline). */
export function messageEncoder(): TransformStream<unknown, Uint8Array> {
    const encoder = new TextEncoder();
    return new TransformStream<unknown, Uint8Array>({
        transform(value, controller) {
            controller.enqueue(encoder.encode(JSON.stringify(value)));
        }
    });
}
