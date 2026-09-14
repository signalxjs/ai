import { describe, it, expect } from 'vitest';
import { mockModel } from '@sigx/ai/testing';
import { collect } from '../helpers';

describe('mockModel', () => {
    it('splits text on word boundaries by default and by chunkSize when asked', async () => {
        const m = mockModel({ script: [{ text: 'ab cd ef' }, { text: 'abcdef', chunkSize: 4 }] });
        const a = await collect(m.stream({ messages: [] }));
        expect(a).toEqual([
            { type: 'text-delta', delta: 'ab ' },
            { type: 'text-delta', delta: 'cd ' },
            { type: 'text-delta', delta: 'ef' },
            { type: 'finish', reason: 'stop' }
        ]);
        const b = await collect(m.stream({ messages: [] }));
        expect(b.slice(0, 2)).toEqual([{ type: 'text-delta', delta: 'abcd' }, { type: 'text-delta', delta: 'ef' }]);
        expect(m.rounds).toBe(2);
        expect(m.requests).toHaveLength(2);
    });

    it('repeats the last scripted reply and honours the abort signal', async () => {
        const m = mockModel({ script: [{ text: 'a b c d', delayMs: 1 }] });
        const ctrl = new AbortController();
        const seen: unknown[] = [];
        for await (const ev of m.stream({ messages: [], signal: ctrl.signal })) {
            seen.push(ev);
            ctrl.abort();
        }
        expect(seen).toHaveLength(1);
        // still answers after — the script's last entry repeats
        expect((await collect(m.stream({ messages: [] }))).at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    });

    it('emits tool calls with generated ids and reasoning', async () => {
        const m = mockModel({ script: [{ reasoning: 'why', toolCalls: [{ name: 't', input: { a: 1 } }] }] });
        const ev = await collect(m.stream({ messages: [] }));
        expect(ev[0]).toEqual({ type: 'reasoning-delta', delta: 'why' });
        expect(ev[1]).toEqual({ type: 'reasoning-end' });
        expect(ev[2]).toMatchObject({ type: 'tool-call', name: 't', input: { a: 1 } });
        expect((ev[2] as { id: string }).id).toMatch(/^call_\d+$/);
        expect(ev[3]).toEqual({ type: 'finish', reason: 'tool' });
    });

    it('emits scripted inputDeltas before the call, carrying its id and name', async () => {
        const m = mockModel({ script: [{ toolCalls: [{ name: 'weather', id: 'c1', input: { city: 'Oslo' }, inputDeltas: ['{"city":', ' "Oslo"}'] }] }] });
        expect(await collect(m.stream({ messages: [] }))).toEqual([
            { type: 'tool-input-delta', id: 'c1', name: 'weather', delta: '{"city":' },
            { type: 'tool-input-delta', id: 'c1', name: 'weather', delta: ' "Oslo"}' },
            { type: 'tool-call', id: 'c1', name: 'weather', input: { city: 'Oslo' } },
            { type: 'finish', reason: 'tool' }
        ]);
    });

    it('gives a generated id to the deltas and the call alike', async () => {
        const m = mockModel({ script: [{ toolCalls: [{ name: 't', input: {}, inputDeltas: ['{}'] }] }] });
        const ev = await collect(m.stream({ messages: [] }));
        const id = (ev[0] as { id: string }).id;
        expect(id).toMatch(/^call_\d+$/);
        expect(ev[1]).toEqual({ type: 'tool-call', id, name: 't', input: {} });
    });
});
