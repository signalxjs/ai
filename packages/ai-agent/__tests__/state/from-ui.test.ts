import { describe, it, expect } from 'vitest';
import { fromUIMessages, toUIMessages } from '@sigx/ai-agent';
import type { UIMessage } from '@sigx/ai';

describe('fromUIMessages', () => {
    const messages: UIMessage[] = [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        {
            id: 'a1',
            role: 'assistant',
            parts: [
                { type: 'reasoning', text: 'hm', providerData: { sig: 1 } },
                { type: 'text', text: 'Hello' },
                { type: 'tool', id: 'c1', name: 'read', input: { p: 1 }, state: 'done', output: 'ok' },
                { type: 'tool', id: 'c2', name: 'rm', input: {}, state: 'error', output: 'boom' },
                { type: 'tool', id: 'c3', name: 'wait', input: {}, state: 'pending' }
            ]
        },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'thanks' }] }
    ];

    it('round-trips through toUIMessages', () => {
        const { transcript, events } = fromUIMessages(messages, { sessionId: 's' });
        expect(toUIMessages(transcript)).toEqual(messages);
        expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
        expect(events.every((e) => e.sessionId === 's' && e.epoch === 1)).toBe(true);
        expect(transcript.messages.map((m) => m.turnId)).toEqual(['import:1', 'import:1', 'import:2']);
    });

    it('synthesises the events that would have produced the transcript', () => {
        const { events } = fromUIMessages(messages.slice(0, 2), { sessionId: 's' });
        expect(events.map((e) => e.type)).toEqual([
            'user-message',
            'part-start',
            'part-delta',
            'part-end',
            'part-start',
            'part-delta',
            'part-end',
            'tool-call',
            'tool-update',
            'tool-call',
            'tool-update',
            'tool-call'
        ]);
        expect(events[3]).toMatchObject({ type: 'part-end', providerData: { sig: 1 } });
        expect(events[8]).toMatchObject({ type: 'tool-update', status: 'completed', output: 'ok' });
        expect(events[10]).toMatchObject({ type: 'tool-update', status: 'failed', error: 'boom' });
    });

    it('honours an epoch and a custom reducer', () => {
        const seen: string[] = [];
        const { events } = fromUIMessages(messages, {
            sessionId: 's',
            epoch: 4,
            reducer: (t, e) => {
                seen.push(e.type);
                return t;
            }
        });
        expect(events[0]!.epoch).toBe(4);
        expect(seen.length).toBe(events.length);
    });
});
