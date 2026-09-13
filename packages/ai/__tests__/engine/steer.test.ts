/**
 * `streamText({ steer })` — input injected into the running tool loop
 * between model rounds, without a chunk of its own.
 */
import { describe, it, expect } from 'vitest';
import { streamText, generateText, defineTool, userMessage, type ModelUserMessage, type UIChunk } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { citySchema, collect } from '../helpers';

const open = defineTool({
    name: 'open',
    description: 'Runs freely',
    input: citySchema,
    execute: async ({ city }) => `free:${city}`
});

const user = (text: string): ModelUserMessage => ({ role: 'user', content: text });
const types = (chunks: UIChunk[]) => chunks.map((c) => c.type);
/** A steer source that hands out its queue once, then nothing. */
const queue = (...batches: ModelUserMessage[][]) => {
    const pending = [...batches];
    return () => pending.shift() ?? [];
};

describe('streamText steer', () => {
    it('injects after a round with tool results, before the next model round', async () => {
        const model = mockModel({
            respond: (_req, round) => (round === 0 ? { toolCalls: [{ name: 'open', input: { city: 'Oslo' }, id: 'c1' }] } : { text: 'done' })
        });
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [open], steer: queue([user('also Rome')]) }));
        expect(types(chunks)).toEqual(['start', 'tool-call', 'tool-result', 'text', 'finish']);
        expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: 'stop' });
        // user, assistant(tool call), tool results, then the steer — in place, before round 1.
        expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
        expect(model.requests[1]!.messages[3]).toEqual({ role: 'user', content: 'also Rome' });
    });

    it('a steer after a final answer runs another round; nothing is yielded for the injection', async () => {
        const model = mockModel({ respond: (_req, round) => ({ text: round === 0 ? 'first' : 'second' }) });
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], steer: queue([user('and then?')]) }));
        expect(types(chunks)).toEqual(['start', 'text', 'text', 'finish']);
        expect(chunks.filter((c) => c.type === 'text').map((c) => (c as { delta: string }).delta)).toEqual(['first', 'second']);
        expect(model.rounds).toBe(2);
        // The first answer stays in the conversation, followed by the steer.
        expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(model.requests[1]!.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'first' }] });
        expect(model.requests[1]!.messages[2]).toEqual({ role: 'user', content: 'and then?' });
    });

    it('an empty drain ends the turn as usual', async () => {
        const model = mockModel({ script: [{ text: 'hi' }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], steer: () => [] }));
        expect(types(chunks)).toEqual(['start', 'text', 'finish']);
        expect(model.rounds).toBe(1);
    });

    it('steer rounds count against maxSteps — the limit ends the turn with finish length', async () => {
        const model = mockModel({ respond: (_req, round) => ({ text: `r${round}` }) });
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], maxSteps: 2, steer: () => [user('more')] }));
        expect(model.rounds).toBe(2);
        expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: 'length' });
    });

    it('several messages in one drain land in order', async () => {
        const model = mockModel({ respond: (_req, round) => ({ text: round === 0 ? 'a' : 'b' }) });
        await collect(streamText({ model, messages: [userMessage('go')], steer: queue([user('one'), user('two')]) }));
        expect(model.requests[1]!.messages.slice(2)).toEqual([user('one'), user('two')]);
    });

    it('generateText passes steer through', async () => {
        const model = mockModel({ respond: (_req, round) => ({ text: round === 0 ? 'first ' : 'second' }) });
        const result = await generateText({ model, messages: [userMessage('go')], steer: queue([user('go on')]) });
        expect(result.text).toBe('first second');
        expect(model.rounds).toBe(2);
    });
});
