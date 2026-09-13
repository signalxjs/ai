import { describe, it, expect } from 'vitest';
import { toModelMessages, userMessage, type UIMessage } from '@sigx/ai';

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

    it('keeps an all-text user message a string and passes image/file parts through in order', () => {
        expect(toModelMessages([{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }])).toEqual([{ role: 'user', content: 'ab' }]);
        const out = toModelMessages([
            {
                id: 'u',
                role: 'user',
                parts: [
                    { type: 'text', text: 'What is this?' },
                    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
                    { type: 'file', mediaType: 'application/pdf', url: 'https://x.test/a.pdf', filename: 'a.pdf' }
                ]
            }
        ]);
        expect(out).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What is this?' },
                    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
                    { type: 'file', mediaType: 'application/pdf', url: 'https://x.test/a.pdf', filename: 'a.pdf' }
                ]
            }
        ]);
    });

    it('omits a pending tool call from the results message', () => {
        const out = toModelMessages([
            { id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: {}, state: 'pending' }] }
        ]);
        expect(out).toEqual([{ role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 't', input: {} }] }]);
    });
    it('sends a denied call back as an error result and omits undecided ones', () => {
        const out = toModelMessages([
            {
                id: 'a',
                role: 'assistant',
                parts: [
                    { type: 'tool', id: 'c1', name: 't', input: {}, state: 'denied', output: 'no' },
                    { type: 'tool', id: 'c2', name: 't', input: {}, state: 'denied' },
                    { type: 'tool', id: 'c3', name: 't', input: {}, state: 'awaiting' },
                    { type: 'tool', id: 'c4', name: 't', input: {}, state: 'approved' }
                ]
            }
        ]);
        expect(out[1]).toEqual({
            role: 'tool',
            content: [
                { type: 'tool-result', toolCallId: 'c1', toolName: 't', output: 'no', isError: true },
                { type: 'tool-result', toolCallId: 'c2', toolName: 't', output: expect.stringMatching(/denied/i), isError: true }
            ]
        });
    });
});
