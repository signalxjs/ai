import { describe, it, expect } from 'vitest';
import { ndjsonDecoder, ndjsonEncoder, messageDecoder, messageEncoder, LineTooLongError } from '@sigx/ai-agent/harness';

async function decode(chunks: Uint8Array[], maxLineBytes?: number): Promise<string[]> {
    const decoder = ndjsonDecoder(maxLineBytes !== undefined ? { maxLineBytes } : {});
    const writer = decoder.writable.getWriter();
    const out: string[] = [];
    const reading = (async () => {
        for await (const line of decoder.readable) out.push(line);
    })();
    try {
        for (const c of chunks) await writer.write(c);
        await writer.close();
    } catch {
        // an errored stream rejects the write; the reader below reports the real cause
    }
    await reading;
    return out;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('ndjsonDecoder', () => {
    it('splits lines across chunk boundaries and tolerates \\r\\n', async () => {
        const text = '{"a":1}\r\n{"b":2}\n\n   \n{"c":3}';
        const bytes = enc(text);
        const lines = await decode([bytes.subarray(0, 3), bytes.subarray(3, 9), bytes.subarray(9, 10), bytes.subarray(10)]);
        expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });

    it('reassembles a multi-byte character split across chunks', async () => {
        const bytes = enc('{"s":"héllo 🚀"}\n');
        // Split inside 'é' (2 bytes) and inside the rocket (4 bytes).
        const i = 6;
        const j = bytes.indexOf(0xf0);
        const lines = await decode([bytes.subarray(0, i), bytes.subarray(i, j + 2), bytes.subarray(j + 2)]);
        expect(lines).toEqual(['{"s":"héllo 🚀"}']);
    });

    it('splits \\r\\n across chunks without leaking the \\r', async () => {
        const lines = await decode([enc('{"a":1}\r'), enc('\n{"b":2}\r\n')]);
        expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('errors the stream on an oversized line', async () => {
        await expect(decode([enc('x'.repeat(50)), enc('y'.repeat(50))], 64)).rejects.toBeInstanceOf(LineTooLongError);
        await expect(decode([enc('x'.repeat(50)), enc('y'.repeat(50))], 64)).rejects.toThrow(/exceeds 64 bytes/);
    });

    it('a complete oversized line inside one chunk trips the limit too', async () => {
        await expect(decode([enc('x'.repeat(100) + '\n{"a":1}\n')], 64)).rejects.toBeInstanceOf(LineTooLongError);
        // Buffered tail plus the completing chunk counts as one line.
        await expect(decode([enc('x'.repeat(40)), enc('y'.repeat(40) + '\n')], 64)).rejects.toBeInstanceOf(LineTooLongError);
    });

    it('a short line followed by newline never trips the limit', async () => {
        expect(await decode([enc('{"a":1}\n{"b":2}\n')], 8)).toEqual(['{"a":1}', '{"b":2}']);
    });
});

describe('encoders', () => {
    it('ndjsonEncoder appends a newline; messageEncoder does not', async () => {
        const collect = async (ts: TransformStream<unknown, Uint8Array>, values: unknown[]) => {
            const w = ts.writable.getWriter();
            const out: string[] = [];
            const reading = (async () => {
                for await (const c of ts.readable) out.push(new TextDecoder().decode(c));
            })();
            for (const v of values) await w.write(v);
            await w.close();
            await reading;
            return out;
        };
        expect(await collect(ndjsonEncoder(), [{ a: 1 }, 'x'])).toEqual(['{"a":1}\n', '"x"\n']);
        expect(await collect(messageEncoder(), [{ a: 1 }])).toEqual(['{"a":1}']);
    });

    it('messageDecoder yields one document per chunk and skips blanks', async () => {
        const d = messageDecoder();
        const w = d.writable.getWriter();
        const out: string[] = [];
        const reading = (async () => {
            for await (const c of d.readable) out.push(c);
        })();
        await w.write(enc('{"a":1}'));
        await w.write(enc('  '));
        await w.write(enc('{"b":2}'));
        await w.close();
        await reading;
        expect(out).toEqual(['{"a":1}', '{"b":2}']);
    });
});
