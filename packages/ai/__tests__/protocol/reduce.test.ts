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

    it('a same-id start is a no-op, so a resumed turn lands on the existing message', () => {
        const m = createMessage('assistant', [{ type: 'text', text: 'kept' }], 'a1');
        expect(applyChunk(m, { type: 'start', messageId: 'a1' })).toBe(false);
        expect(m.id).toBe('a1');
        expect(m.parts).toEqual([{ type: 'text', text: 'kept' }]);
    });
});
