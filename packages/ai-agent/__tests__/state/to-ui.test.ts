import { describe, it, expect } from 'vitest';
import { createTranscript, reduceAgentEvent, toUIMessages, promptPartsToUI, contentToOutput, type AgentEvent, type UnstampedEvent } from '@sigx/ai-agent';
import { toModelMessages } from '@sigx/ai';

let seq = 0;
const ev = (payload: UnstampedEvent): AgentEvent => ({ ...payload, sessionId: 's', epoch: 1, seq: ++seq });

function transcriptOf(events: readonly AgentEvent[]) {
    const t = createTranscript('s');
    for (const e of events) reduceAgentEvent(t, e);
    return t;
}

describe('toUIMessages', () => {
    it('maps user and assistant messages, parts and tool states', () => {
        seq = 0;
        const t = transcriptOf([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'user-message', turnId: 't1', messageId: 'u1', parts: [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: 'AAA=' }, { type: 'resource', uri: 'file:///a.txt' }] }),
            ev({ type: 'part-start', turnId: 't1', messageId: 'a1', partId: 'p1', kind: 'reasoning' }),
            ev({ type: 'part-delta', turnId: 't1', partId: 'p1', delta: 'think' }),
            ev({ type: 'part-end', turnId: 't1', partId: 'p1', providerData: { sig: 'x' } }),
            ev({ type: 'part-start', turnId: 't1', messageId: 'a1', partId: 'p2', kind: 'text' }),
            ev({ type: 'part-delta', turnId: 't1', partId: 'p2', delta: 'Hello' }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c1', name: 'done', input: { a: 1 } }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed', output: { ok: true } }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c2', name: 'failed' }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c2', status: 'failed', error: 'boom' }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c3', name: 'pending' }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c4', name: 'denied' }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c4', status: 'denied', error: 'no' }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c5', name: 'awaiting' }),
            ev({ type: 'request', turnId: 't1', requestId: 'r1', kind: 'permission', callId: 'c5' }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c6', name: 'content' }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c6', status: 'completed', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })
        ]);
        const ui = toUIMessages(t);
        expect(ui).toHaveLength(2);
        expect(ui[0]).toEqual({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: 'AAA=' }, { type: 'text', text: 'file:///a.txt' }] });
        expect(ui[1]!.parts).toEqual([
            { type: 'reasoning', text: 'think', providerData: { sig: 'x' } },
            { type: 'text', text: 'Hello' },
            { type: 'tool', id: 'c1', name: 'done', input: { a: 1 }, state: 'done', output: { ok: true } },
            { type: 'tool', id: 'c2', name: 'failed', input: null, state: 'error', output: 'boom' },
            { type: 'tool', id: 'c3', name: 'pending', input: null, state: 'pending' },
            { type: 'tool', id: 'c4', name: 'denied', input: null, state: 'denied', output: 'no' },
            { type: 'tool', id: 'c5', name: 'awaiting', input: null, state: 'awaiting' },
            { type: 'tool', id: 'c6', name: 'content', input: null, state: 'done', output: 'a\nb' }
        ]);
    });

    it('feeds toModelMessages: settled tools become tool results', () => {
        seq = 0;
        const t = transcriptOf([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'user-message', turnId: 't1', messageId: 'u1', parts: [{ type: 'text', text: 'hi' }] }),
            ev({ type: 'tool-call', turnId: 't1', messageId: 'a1', callId: 'c1', name: 'x', input: {} }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed', output: 42 })
        ]);
        const model = toModelMessages(toUIMessages(t));
        expect(model).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', input: {} }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'x', output: 42 }] }
        ]);
    });

    it('flattens nested subagent output into the parent message with a marker', () => {
        seq = 0;
        const t = transcriptOf([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'delegate' }),
            ev({ type: 'part-start', turnId: 't1', parentCallId: 'c1', messageId: 'sub', partId: 'sp', kind: 'text', actor: 'researcher' }),
            ev({ type: 'part-delta', turnId: 't1', parentCallId: 'c1', partId: 'sp', delta: 'found it' }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed', output: 'summary' })
        ]);
        const ui = toUIMessages(t);
        expect(ui).toHaveLength(1);
        expect(ui[0]!.parts).toEqual([
            { type: 'tool', id: 'c1', name: 'delegate', input: null, state: 'done', output: 'summary' },
            { type: 'text', text: '[researcher c1] found it' }
        ]);
    });

    it('omits nested subagent messages when asked, so a host model never reads them as its own words', () => {
        seq = 0;
        const t = transcriptOf([
            ev({ type: 'turn-start', turnId: 't1', input: [] }),
            ev({ type: 'user-message', turnId: 't1', messageId: 'u1', parts: [{ type: 'text', text: 'go' }] }),
            ev({ type: 'tool-call', turnId: 't1', callId: 'c1', name: 'delegate' }),
            ev({ type: 'part-start', turnId: 't1', parentCallId: 'c1', messageId: 'sub', partId: 'sp', kind: 'text', actor: 'researcher' }),
            ev({ type: 'part-delta', turnId: 't1', parentCallId: 'c1', partId: 'sp', delta: 'found it' }),
            ev({ type: 'user-message', turnId: 't1', parentCallId: 'c1', messageId: 'subu', parts: [{ type: 'text', text: 'nested prompt' }] }),
            ev({ type: 'tool-update', turnId: 't1', callId: 'c1', status: 'completed', output: 'summary' })
        ]);
        const omitted = toUIMessages(t, { subagents: 'omit' });
        expect(omitted.map((m) => m.id)).toEqual(['u1', 'a:t1:0']);
        expect(omitted[1]!.parts).toEqual([{ type: 'tool', id: 'c1', name: 'delegate', input: null, state: 'done', output: 'summary' }]);
        // The default is unchanged: flatten folds every nested message, the user one included.
        expect(toUIMessages(t, { subagents: 'flatten' })).toEqual(toUIMessages(t));
        expect(toUIMessages(t)[1]!.parts).toHaveLength(3);
    });

    it('promptPartsToUI maps prompt parts the way user messages are mapped', () => {
        expect(promptPartsToUI([{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: 'AAA=' }, { type: 'resource', uri: 'file:///a.txt', text: 'body' }])).toEqual([
            { type: 'text', text: 'hi' },
            { type: 'image', mediaType: 'image/png', data: 'AAA=' },
            { type: 'text', text: 'body' }
        ]);
    });

    it('contentToOutput picks the natural JSON form', () => {
        expect(contentToOutput([{ type: 'json', value: { a: 1 } }])).toEqual({ a: 1 });
        expect(contentToOutput([{ type: 'text', text: 'x' }])).toBe('x');
        expect(contentToOutput([{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }])).toBe('x\ny');
        expect(contentToOutput([{ type: 'text', text: 'x' }, { type: 'json', value: 1 }])).toEqual(['x', 1]);
    });
});
