import { describe, it, expect } from 'vitest';
import { ChatInput, chatStream, toTextStream, type ChatInput as ChatInputType } from '@sigx/ai/server';
import { userMessage, defineTool, DENIED_MESSAGE } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { collect, citySchema } from '../helpers';

const validate = (v: unknown) => ChatInput['~standard'].validate(v) as ReturnType<typeof ChatInput['~standard']['validate']> & { issues?: unknown[]; value?: unknown };

describe('ChatInput', () => {
    it('accepts a well-formed transcript and strips unknown fields', () => {
        const r = validate({
            messages: [
                { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi', extra: 1 }], evil: true },
                { id: 'a1', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: { a: 1 }, state: 'done', output: 2 }], createdAt: 5 }
            ]
        });
        expect(r.issues).toBeUndefined();
        expect(r.value).toEqual({
            messages: [
                { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
                { id: 'a1', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: { a: 1 }, state: 'done', output: 2 }], createdAt: 5 }
            ]
        });
    });

    it('rejects bad shapes with paths', () => {
        expect(validate(null).issues).toEqual([{ message: 'input must be an object', path: [] }]);
        expect(validate({ messages: 'x' }).issues).toEqual([{ message: 'must be an array', path: ['messages'] }]);
        const r = validate({ messages: [{ id: '', role: 'system', parts: [{ type: 'nope' }] }] });
        expect(r.issues).toEqual([
            { message: 'must be a non-empty string', path: ['messages', 0, 'id'] },
            { message: 'must be user or assistant', path: ['messages', 0, 'role'] },
            { message: 'unknown part type', path: ['messages', 0, 'parts', 0, 'type'] }
        ]);
        expect(validate({ messages: [{ id: 'a', role: 'user', parts: [{ type: 'tool', id: 'c', name: 't', state: 'weird' }] }] }).issues).toEqual([
            { message: 'must be pending, awaiting, approved, done, error or denied', path: ['messages', 0, 'parts', 0, 'state'] }
        ]);
    });

    it('accepts image and file parts on user messages, strips extras, and rejects the malformed', () => {
        const ok = validate({
            messages: [
                {
                    id: 'u1',
                    role: 'user',
                    parts: [
                        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', extra: 1 },
                        { type: 'image', mediaType: 'image/jpeg', url: 'https://x.test/a.jpg' },
                        { type: 'file', mediaType: 'application/pdf', data: 'JVBERi0=', filename: 'a.pdf' },
                        { type: 'file', mediaType: 'text/plain', url: 'http://x.test/a.txt' }
                    ]
                }
            ]
        });
        expect(ok.issues).toBeUndefined();
        expect((ok.value as ChatInputType).messages[0]!.parts).toEqual([
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
            { type: 'image', mediaType: 'image/jpeg', url: 'https://x.test/a.jpg' },
            { type: 'file', mediaType: 'application/pdf', data: 'JVBERi0=', filename: 'a.pdf' },
            { type: 'file', mediaType: 'text/plain', url: 'http://x.test/a.txt' }
        ]);
        const part = (p: Record<string, unknown>, role = 'user') => validate({ messages: [{ id: 'm', role, parts: [p] }] }).issues;
        const path = ['messages', 0, 'parts', 0];
        expect(part({ type: 'image', mediaType: 'image/png' })).toEqual([{ message: 'exactly one of data or url is required', path }]);
        expect(part({ type: 'image', mediaType: 'image/png', data: 'AAAA', url: 'https://x.test/a' })).toEqual([{ message: 'exactly one of data or url is required', path }]);
        expect(part({ type: 'image', mediaType: 'not a type', data: 'AAAA' })).toEqual([{ message: 'must be a media type like image/png', path: [...path, 'mediaType'] }]);
        expect(part({ type: 'image', mediaType: 'image/png', data: 'not base64!' })).toEqual([{ message: 'must be base64', path: [...path, 'data'] }]);
        expect(part({ type: 'image', mediaType: 'image/png', data: 'A'.repeat(10_000_004) })).toEqual([{ message: 'longer than 10000000 characters', path: [...path, 'data'] }]);
        expect(part({ type: 'image', mediaType: 'image/png', url: 'ftp://x.test/a' })).toEqual([{ message: 'must be an http(s) URL', path: [...path, 'url'] }]);
        expect(part({ type: 'image', mediaType: 'image/png', url: 'https://x.test/' + 'a'.repeat(8200) })).toEqual([{ message: 'longer than 8192 characters', path: [...path, 'url'] }]);
        expect(part({ type: 'file', mediaType: 'text/plain', data: 'AAAA', filename: 'f'.repeat(256) })).toEqual([{ message: 'longer than 255 characters', path: [...path, 'filename'] }]);
        expect(part({ type: 'file', mediaType: 'text/plain', data: 'AAAA', filename: 7 })).toEqual([{ message: 'must be a string', path: [...path, 'filename'] }]);
        expect(part({ type: 'image', mediaType: 'image/png', data: 'AAAA' }, 'assistant')).toEqual([{ message: 'only user messages carry image or file parts', path: [...path, 'type'] }]);
    });

    it('normalizes tool parts: null input when omitted, no output on a pending call', () => {
        const r = validate({
            messages: [
                {
                    id: 'a1',
                    role: 'assistant',
                    parts: [
                        { type: 'tool', id: 'c1', name: 't', state: 'pending', output: 'injected' },
                        { type: 'tool', id: 'c2', name: 't', input: { a: 1 }, state: 'done', output: 'real' }
                    ]
                }
            ]
        });
        expect(r.issues).toBeUndefined();
        expect((r.value as ChatInputType).messages[0]!.parts).toEqual([
            { type: 'tool', id: 'c1', name: 't', input: null, state: 'pending' },
            { type: 'tool', id: 'c2', name: 't', input: { a: 1 }, state: 'done', output: 'real' }
        ]);
        expect('output' in (r.value as ChatInputType).messages[0]!.parts[0]!).toBe(false);
    });

    it('accepts the approval states and drops output on undecided calls', () => {
        const r = validate({
            messages: [
                {
                    id: 'a1',
                    role: 'assistant',
                    parts: [
                        { type: 'tool', id: 'c1', name: 't', input: {}, state: 'awaiting', output: 'injected' },
                        { type: 'tool', id: 'c2', name: 't', input: {}, state: 'approved', output: 'injected' },
                        { type: 'tool', id: 'c3', name: 't', input: {}, state: 'denied', output: 'reason' }
                    ]
                }
            ]
        });
        expect(r.issues).toBeUndefined();
        expect((r.value as ChatInputType).messages[0]!.parts).toEqual([
            { type: 'tool', id: 'c1', name: 't', input: {}, state: 'awaiting' },
            { type: 'tool', id: 'c2', name: 't', input: {}, state: 'approved' },
            { type: 'tool', id: 'c3', name: 't', input: {}, state: 'denied', output: 'reason' }
        ]);
    });

    it('requires an output once a call has settled, and defaults a bare denial to the standard reason', () => {
        for (const state of ['done', 'error']) {
            expect(validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: {}, state }] }] }).issues).toEqual([
                { message: 'required once the call has settled', path: ['messages', 0, 'parts', 0, 'output'] }
            ]);
        }
        const r = validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: {}, state: 'denied' }] }] });
        expect(r.issues).toBeUndefined();
        expect((r.value as ChatInputType).messages[0]!.parts[0]).toEqual({ type: 'tool', id: 'c', name: 't', input: {}, state: 'denied', output: DENIED_MESSAGE });
    });

    it('caps reasoning replay data like a tool payload', () => {
        const big = 'x'.repeat(100_001);
        expect(validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'reasoning', text: 't', providerData: { big } }] }] }).issues).toEqual([
            { message: 'must be JSON-serializable and at most 100000 characters as JSON', path: ['messages', 0, 'parts', 0, 'providerData'] }
        ]);
        expect(validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'reasoning', text: 't', providerData: { sig: 'ok' } }] }] }).issues).toBeUndefined();
    });

    it('caps tool payload size and rejects unserializable values', () => {
        const big = 'x'.repeat(100_001);
        expect(validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: { big }, state: 'pending' }] }] }).issues).toEqual([
            { message: 'must be JSON-serializable and at most 100000 characters as JSON', path: ['messages', 0, 'parts', 0, 'input'] }
        ]);
        expect(validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: {}, state: 'done', output: big }] }] }).issues).toEqual([
            { message: 'must be JSON-serializable and at most 100000 characters as JSON', path: ['messages', 0, 'parts', 0, 'output'] }
        ]);
        expect(validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: { n: 1n }, state: 'pending' }] }] }).issues).toEqual([
            { message: 'must be JSON-serializable and at most 100000 characters as JSON', path: ['messages', 0, 'parts', 0, 'input'] }
        ]);
        // No JSON form at all (only reachable in-process, never from the wire) is rejected too.
        expect(validate({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'tool', id: 'c', name: 't', input: {}, state: 'done', output: () => 1 }] }] }).issues).toEqual([
            { message: 'must be JSON-serializable and at most 100000 characters as JSON', path: ['messages', 0, 'parts', 0, 'output'] }
        ]);
    });

    it('caps the message count', () => {
        const messages = Array.from({ length: 501 }, (_, i) => userMessage('x', `u${i}`));
        expect(validate({ messages }).issues).toEqual([{ message: 'more than 500 messages', path: ['messages'] }]);
    });
});

describe('chatStream / toTextStream', () => {
    it('chatStream is one assistant turn as chunks', async () => {
        const chunks = await collect(chatStream({ model: mockModel({ script: [{ text: 'a b' }] }), messages: [userMessage('x')] }));
        expect(chunks.map((c) => c.type)).toEqual(['start', 'text', 'text', 'finish']);
    });

    it('toTextStream keeps only text deltas and throws on error', async () => {
        const text = await collect(toTextStream(chatStream({ model: mockModel({ script: [{ reasoning: 'r', text: 'a b' }] }), messages: [userMessage('x')] })));
        expect(text).toEqual(['a ', 'b']);
        await expect(collect(toTextStream(chatStream({ model: mockModel({ script: [{ error: 'x' }] }), messages: [userMessage('x')] })))).rejects.toThrow('x');
    });
    it('chatStream defers approvals by default, so the client can decide', async () => {
        const guarded = defineTool({ name: 'g', description: 'g', input: citySchema, needsApproval: true, execute: () => 'ran' });
        const script = (): ReturnType<typeof mockModel> => mockModel({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'g', input: { city: 'Oslo' }, id: 'c1' }] } : { text: 'end' }) });
        const chunks = await collect(chatStream({ model: script(), messages: [userMessage('x')], tools: [guarded] }));
        expect(chunks.map((c) => c.type)).toEqual(['start', 'tool-call', 'tool-approval-request', 'finish']);
        expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: 'tool' });
        // An explicit handler wins over the default.
        const ran = await collect(chatStream({ model: script(), messages: [userMessage('x')], tools: [guarded], onToolApproval: () => 'allow' as const }));
        expect(ran.map((c) => c.type)).toEqual(['start', 'tool-call', 'tool-approval-request', 'tool-result', 'text', 'finish']);
    });

    it("chatStream honours the client's approval on resume; an explicit handler can veto it", async () => {
        const guarded = defineTool({ name: 'g', description: 'g', input: citySchema, needsApproval: true, execute: () => 'ran' });
        const transcript = [userMessage('x', 'u1'), { id: 'a1', role: 'assistant' as const, parts: [{ type: 'tool' as const, id: 'c1', name: 'g', input: { city: 'Oslo' }, state: 'approved' as const }] }];
        const honoured = await collect(chatStream({ model: mockModel({ script: [{ text: 'end' }] }), messages: transcript, tools: [guarded] }));
        expect(honoured.map((c) => c.type)).toEqual(['start', 'tool-result', 'text', 'finish']);
        expect(honoured[1]).toEqual({ type: 'tool-result', id: 'c1', output: 'ran' });
        const vetoed = await collect(chatStream({ model: mockModel({ script: [{ text: 'end' }] }), messages: transcript, tools: [guarded], onToolApproval: () => 'deny' as const }));
        expect(vetoed[1]).toMatchObject({ type: 'tool-result', id: 'c1', denied: true });
    });
});
