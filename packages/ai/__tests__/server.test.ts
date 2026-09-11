import { describe, it, expect } from 'vitest';
import { ChatInput, chatStream, toTextStream } from '@sigx/ai/server';
import { userMessage } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { collect } from './helpers';

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
            { message: 'must be pending, done or error', path: ['messages', 0, 'parts', 0, 'state'] }
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
});
