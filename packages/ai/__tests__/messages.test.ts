import { describe, it, expect } from 'vitest';
import { toModelMessages, applyChunk, assembleMessage, createMessage, userMessage, messageText, type UIMessage, type UIChunk } from '@sigx/ai';

describe('toModelMessages', () => {
    it('splits tool parts into an assistant call and one tool-result message', () => {
        const transcript: UIMessage[] = [
            userMessage('hi', 'u1'),
            {
                id: 'a1',
                role: 'assistant',
                parts: [
                    { type: 'reasoning', text: 'thinking…', providerData: { type: 'thinking', signature: 's' } },
                    { type: 'text', text: 'Let me check.' },
                    { type: 'tool', id: 'c1', name: 'weather', input: { city: 'Oslo' }, state: 'done', output: { tempC: 3 } },
                    { type: 'tool', id: 'c2', name: 'weather', input: { city: 'Rome' }, state: 'error', output: 'boom' }
                ]
            },
            { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Oslo is 3°C.' }] }
        ];
        expect(toModelMessages(transcript)).toEqual([
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: [
                    { type: 'reasoning', text: 'thinking…', providerData: { type: 'thinking', signature: 's' } },
                    { type: 'text', text: 'Let me check.' },
                    { type: 'tool-call', id: 'c1', name: 'weather', input: { city: 'Oslo' } },
                    { type: 'tool-call', id: 'c2', name: 'weather', input: { city: 'Rome' } }
                ]
            },
            {
                role: 'tool',
                content: [
                    { type: 'tool-result', toolCallId: 'c1', toolName: 'weather', output: { tempC: 3 } },
                    { type: 'tool-result', toolCallId: 'c2', toolName: 'weather', output: 'boom', isError: true }
                ]
            },
            { role: 'assistant', content: [{ type: 'text', text: 'Oslo is 3°C.' }] }
        ]);
    });

    it('omits a pending tool call from the results message', () => {
        const out = toModelMessages([
            { id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: {}, state: 'pending' }] }
        ]);
        expect(out).toEqual([{ role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 't', input: {} }] }]);
    });
});

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

    it('marks an errored tool result', () => {
        const m = createMessage('assistant');
        applyChunk(m, { type: 'tool-call', id: 'c', name: 't', input: null });
        applyChunk(m, { type: 'tool-result', id: 'c', output: 'bad', isError: true });
        expect(m.parts[0]).toMatchObject({ state: 'error', output: 'bad' });
        expect(applyChunk(m, { type: 'finish', reason: 'stop' })).toBe(true);
    });
});
