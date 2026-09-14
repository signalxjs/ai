import { describe, it, expect } from 'vitest';
import { applyChunk, assembleMessage, createMessage, messageText, type UIChunk } from '@sigx/ai';

describe('applyChunk / assembleMessage', () => {
    it('folds chunks into parts in order, merging adjacent text', async () => {
        const chunks: UIChunk[] = [
            { type: 'start', messageId: 'm1' },
            { type: 'reasoning', delta: 'hm' },
            { type: 'reasoning', delta: 'm' },
            { type: 'reasoning-end', providerData: { sig: 1 } },
            { type: 'text', delta: 'Hel' },
            { type: 'text', delta: 'lo' },
            { type: 'tool-call', id: 'c1', name: 't', input: { a: 1 } },
            { type: 'tool-result', id: 'c1', output: 'r' },
            { type: 'text', delta: 'Done' },
            { type: 'finish', reason: 'stop' }
        ];
        const { message, last } = await assembleMessage((async function* () { yield* chunks; })());
        expect(message.id).toBe('m1');
        expect(message.parts).toEqual([
            { type: 'reasoning', text: 'hmm', providerData: { sig: 1 } },
            { type: 'text', text: 'Hello' },
            { type: 'tool', id: 'c1', name: 't', input: { a: 1 }, state: 'done', output: 'r' },
            { type: 'text', text: 'Done' }
        ]);
        expect(messageText(message)).toBe('HelloDone');
        expect(last).toEqual({ type: 'finish', reason: 'stop' });
    });

    it('assembleMessage stops at the terminal chunk', async () => {
        const chunks: UIChunk[] = [
            { type: 'text', delta: 'done' },
            { type: 'finish', reason: 'stop' },
            { type: 'text', delta: ' — stray' }
        ];
        const { message, last } = await assembleMessage((async function* () { yield* chunks; })());
        expect(message.parts).toEqual([{ type: 'text', text: 'done' }]);
        expect(last).toEqual({ type: 'finish', reason: 'stop' });
    });

    it('keeps replay data that arrives as a bare reasoning-end (a redacted block)', () => {
        const m = createMessage('assistant');
        applyChunk(m, { type: 'reasoning-end', providerData: { type: 'redacted_thinking', data: 'X' } });
        applyChunk(m, { type: 'reasoning', delta: 'visible' });
        applyChunk(m, { type: 'reasoning-end', providerData: { type: 'thinking', signature: 'S' } });
        applyChunk(m, { type: 'reasoning-end' });
        expect(m.parts).toEqual([
            { type: 'reasoning', text: '', providerData: { type: 'redacted_thinking', data: 'X' } },
            { type: 'reasoning', text: 'visible', providerData: { type: 'thinking', signature: 'S' } }
        ]);
    });

    it('adopts the id a start chunk announces', () => {
        const m = createMessage('assistant', [], 'placeholder');
        applyChunk(m, { type: 'start', messageId: 'srv_1' });
        expect(m.id).toBe('srv_1');
    });

    it('marks an errored tool result', () => {
        const m = createMessage('assistant');
        applyChunk(m, { type: 'tool-call', id: 'c', name: 't', input: null });
        applyChunk(m, { type: 'tool-result', id: 'c', output: 'bad', isError: true });
        expect(m.parts[0]).toMatchObject({ state: 'error', output: 'bad' });
        expect(applyChunk(m, { type: 'finish', reason: 'stop' })).toBe(true);
    });
    it('tracks approval: awaiting on request, denied on a denied result', () => {
        const m = createMessage('assistant');
        applyChunk(m, { type: 'tool-call', id: 'c', name: 't', input: null });
        expect(applyChunk(m, { type: 'tool-approval-request', id: 'c' })).toBe(false);
        expect(m.parts[0]).toMatchObject({ type: 'tool', state: 'awaiting' });
        applyChunk(m, { type: 'tool-result', id: 'c', output: 'nope', isError: true, denied: true });
        expect(m.parts[0]).toMatchObject({ state: 'denied', output: 'nope' });
        // A late request never reopens a settled call.
        applyChunk(m, { type: 'tool-approval-request', id: 'c' });
        expect(m.parts[0]).toMatchObject({ state: 'denied' });
    });

    it('opens a streaming tool part on tool-input and grows inputText, with input readable mid-stream', () => {
        const m = createMessage('assistant');
        expect(applyChunk(m, { type: 'tool-input', id: 'c1', name: 'weather', delta: '{"city":' })).toBe(false);
        expect(m.parts).toEqual([{ type: 'tool', id: 'c1', name: 'weather', input: {}, state: 'streaming', inputText: '{"city":' }]);
        applyChunk(m, { type: 'tool-input', id: 'c1', name: 'weather', delta: ' "Os' });
        // The prefix is repaired, so the partial object is already readable.
        expect(m.parts[0]).toEqual({ type: 'tool', id: 'c1', name: 'weather', input: { city: 'Os' }, state: 'streaming', inputText: '{"city": "Os' });
        applyChunk(m, { type: 'tool-input', id: 'c1', name: 'weather', delta: 'lo"}' });
        expect(m.parts[0]).toMatchObject({ input: { city: 'Oslo' }, inputText: '{"city": "Oslo"}' });
    });

    it('tool-call settles the streaming part in place rather than adding a second one', () => {
        const m = createMessage('assistant');
        applyChunk(m, { type: 'text', delta: 'Checking ' });
        applyChunk(m, { type: 'tool-input', id: 'c1', name: 'weather', delta: '{"city":' });
        applyChunk(m, { type: 'tool-call', id: 'c1', name: 'weather', input: { city: 'Oslo' } });
        expect(m.parts).toEqual([
            { type: 'text', text: 'Checking ' },
            { type: 'tool', id: 'c1', name: 'weather', input: { city: 'Oslo' }, state: 'pending' }
        ]);
        // The raw text is gone, not merely emptied.
        expect('inputText' in (m.parts[1] as object)).toBe(false);
        applyChunk(m, { type: 'tool-result', id: 'c1', output: { tempC: 3 } });
        expect(m.parts[1]).toMatchObject({ state: 'done', output: { tempC: 3 } });
        expect(m.parts).toHaveLength(2);
    });

    it('keeps two streaming calls apart, and ignores a stale delta for a call that already landed', () => {
        const m = createMessage('assistant');
        applyChunk(m, { type: 'tool-input', id: 'a', name: 't1', delta: '{"x":1' });
        applyChunk(m, { type: 'tool-input', id: 'b', name: 't2', delta: '{"y":2' });
        applyChunk(m, { type: 'tool-input', id: 'a', name: 't1', delta: '}' });
        expect(m.parts).toEqual([
            { type: 'tool', id: 'a', name: 't1', input: { x: 1 }, state: 'streaming', inputText: '{"x":1}' },
            { type: 'tool', id: 'b', name: 't2', input: { y: 2 }, state: 'streaming', inputText: '{"y":2' }
        ]);
        applyChunk(m, { type: 'tool-call', id: 'a', name: 't1', input: { x: 1 } });
        applyChunk(m, { type: 'tool-input', id: 'a', name: 't1', delta: 'STALE' });
        expect(m.parts[0]).toEqual({ type: 'tool', id: 'a', name: 't1', input: { x: 1 }, state: 'pending' });
    });

    it('a same-id start is a no-op, so a resumed turn lands on the existing message', () => {
        const m = createMessage('assistant', [{ type: 'text', text: 'kept' }], 'a1');
        expect(applyChunk(m, { type: 'start', messageId: 'a1' })).toBe(false);
        expect(m.id).toBe('a1');
        expect(m.parts).toEqual([{ type: 'text', text: 'kept' }]);
    });
});
