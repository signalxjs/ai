import { describe, it, expect, vi } from 'vitest';
import { streamText, generateText, generateObject, streamObject, defineTool, userMessage, type LanguageModel, type ModelEvent, type UIChunk, type UIMessage } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { citySchema, collect, textOf, schema } from '../helpers';

const weather = defineTool({
    name: 'weather',
    description: 'Weather for a city',
    input: citySchema,
    execute: async ({ city }) => ({ city, tempC: city.length })
});

describe('streamText', () => {
    it('streams text as chunks framed by start and finish', async () => {
        const model = mockModel({ script: [{ text: 'Hello brave new world', usage: { inputTokens: 3, outputTokens: 4 } }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('hi')], messageId: 'm1' }));
        expect(chunks[0]).toEqual({ type: 'start', messageId: 'm1' });
        expect(textOf(chunks)).toBe('Hello brave new world');
        expect(chunks.filter((c) => c.type === 'text').length).toBeGreaterThan(1);
        expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: 'stop', usage: { inputTokens: 3, outputTokens: 4 } });
        expect(model.requests[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('runs parallel tool calls and returns every result in ONE tool message', async () => {
        const model = mockModel({
            respond: (req, round) =>
                round === 0
                    ? { toolCalls: [{ name: 'weather', input: { city: 'Oslo' }, id: 'c1' }, { name: 'weather', input: { city: 'Rome' }, id: 'c2' }], usage: { outputTokens: 5 } }
                    : { text: `Answer from ${req.messages.length} messages`, usage: { outputTokens: 2 } }
        });
        const chunks = await collect(streamText({ model, messages: [userMessage('weather?')], tools: [weather] }));
        const types = chunks.map((c) => c.type);
        expect(types).toEqual(['start', 'tool-call', 'tool-call', 'tool-result', 'tool-result', 'text', 'text', 'text', 'text', 'finish']);
        expect(chunks[3]).toEqual({ type: 'tool-result', id: 'c1', output: { city: 'Oslo', tempC: 4 } });
        expect(chunks[4]).toEqual({ type: 'tool-result', id: 'c2', output: { city: 'Rome', tempC: 4 } });
        // Second round saw: user, assistant (2 calls), ONE tool message with 2 results.
        const second = model.requests[1]!.messages;
        expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
        expect(second[2]).toEqual({
            role: 'tool',
            content: [
                { type: 'tool-result', toolCallId: 'c1', toolName: 'weather', output: { city: 'Oslo', tempC: 4 } },
                { type: 'tool-result', toolCallId: 'c2', toolName: 'weather', output: { city: 'Rome', tempC: 4 } }
            ]
        });
        // Usage is summed over the turn.
        expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: 'stop', usage: { outputTokens: 7 } });
        expect(textOf(chunks)).toBe('Answer from 3 messages');
    });

    it('forwards tool-input deltas in order, before the assembled call', async () => {
        const model = mockModel({
            respond: (_req, round) =>
                round === 0
                    ? { toolCalls: [{ name: 'weather', input: { city: 'Oslo' }, id: 'c1', inputDeltas: ['{"city":', ' "Oslo"}'] }] }
                    : { text: 'ok' }
        });
        const chunks = await collect(streamText({ model, messages: [userMessage('weather?')], tools: [weather] }));
        expect(chunks.map((c) => c.type)).toEqual(['start', 'tool-input', 'tool-input', 'tool-call', 'tool-result', 'text', 'finish']);
        expect(chunks[1]).toEqual({ type: 'tool-input', id: 'c1', name: 'weather', delta: '{"city":' });
        expect(chunks[2]).toEqual({ type: 'tool-input', id: 'c1', name: 'weather', delta: ' "Oslo"}' });
        expect(chunks[3]).toEqual({ type: 'tool-call', id: 'c1', name: 'weather', input: { city: 'Oslo' } });
        // The deltas are a UI affordance only: the model side carries the
        // assembled call and nothing else.
        expect(model.requests[1]!.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'weather', input: { city: 'Oslo' } }] });
    });

    it('reports an unknown tool and bad arguments as error results, and keeps going', async () => {
        const model = mockModel({
            respond: (_req, round) =>
                round === 0 ? { toolCalls: [{ name: 'nope', input: {}, id: 'c1' }, { name: 'weather', input: { city: 7 }, id: 'c2' }] } : { text: 'ok' }
        });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], tools: [weather] }));
        expect(chunks.find((c) => c.type === 'tool-result' && c.id === 'c1')).toMatchObject({ isError: true, output: 'Unknown tool "nope".' });
        expect(chunks.find((c) => c.type === 'tool-result' && c.id === 'c2')).toMatchObject({ isError: true, output: expect.stringMatching(/Invalid arguments/) });
        expect(model.requests[1]!.messages[2]).toMatchObject({ role: 'tool', content: [{ isError: true }, { isError: true }] });
        expect(textOf(chunks)).toBe('ok');
    });

    it('normalizes tool results for the wire: undefined becomes null, unserializable is an error', async () => {
        const nothing = defineTool({ name: 'nothing', description: 'n', input: citySchema, execute: () => undefined });
        const bigint = defineTool({ name: 'bigint', description: 'b', input: citySchema, execute: () => ({ n: 1n }) });
        const model = mockModel({
            respond: (_r, round) =>
                round === 0 ? { toolCalls: [{ name: 'nothing', input: { city: 'a' }, id: 'c1' }, { name: 'bigint', input: { city: 'b' }, id: 'c2' }] } : { text: 'ok' }
        });
        const nan = defineTool({ name: 'nan', description: 'n', input: citySchema, execute: () => ({ ratio: NaN }) });
        const sparse = defineTool({ name: 'sparse', description: 's', input: citySchema, execute: () => ({ kept: 1, dropped: undefined }) });
        const chunks = await collect(
            streamText({
                model: mockModel({
                    respond: (_r, round) =>
                        round === 0
                            ? { toolCalls: [{ name: 'nothing', input: { city: 'a' }, id: 'c1' }, { name: 'bigint', input: { city: 'b' }, id: 'c2' }, { name: 'nan', input: { city: 'c' }, id: 'c3' }, { name: 'sparse', input: { city: 'd' }, id: 'c4' }] }
                            : { text: 'ok' }
                }),
                messages: [userMessage('x')],
                tools: [nothing, bigint, nan, sparse]
            })
        );
        void model;
        expect(chunks.find((c) => c.type === 'tool-result' && c.id === 'c1')).toEqual({ type: 'tool-result', id: 'c1', output: null });
        expect(chunks.find((c) => c.type === 'tool-result' && c.id === 'c2')).toMatchObject({ isError: true, output: expect.stringMatching(/not JSON-serializable/) });
        // A non-finite number would silently encode as null — an error instead.
        expect(chunks.find((c) => c.type === 'tool-result' && c.id === 'c3')).toMatchObject({ isError: true, output: expect.stringMatching(/non-finite number at "ratio"/) });
        // A nested undefined member is plain JSON semantics: omitted, not an error —
        // and omitted in-process too, so the shape matches the wire exactly.
        const sparseResult = chunks.find((c) => c.type === 'tool-result' && c.id === 'c4') as { output: Record<string, unknown> };
        expect(sparseResult).toEqual({ type: 'tool-result', id: 'c4', output: { kept: 1 } });
        expect('dropped' in sparseResult.output).toBe(false);
        // Every chunk survives the wire codec.
        for (const c of chunks) expect(() => JSON.stringify(c)).not.toThrow();
        expect(textOf(chunks)).toBe('ok');
    });

    it('treats a non-finite maxSteps as the default', async () => {
        const model = mockModel({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'weather', input: { city: 'A' } }] } : { text: 'done' }) });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], tools: [weather], maxSteps: Number.NaN }));
        expect(model.rounds).toBe(2);
        expect(textOf(chunks)).toBe('done');
    });

    it('stops at maxSteps and reports the unrun calls', async () => {
        const model = mockModel({ script: [{ toolCalls: [{ name: 'weather', input: { city: 'Oslo' }, id: 'c' }] }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], tools: [weather], maxSteps: 2 }));
        expect(model.rounds).toBe(2);
        const results = chunks.filter((c) => c.type === 'tool-result');
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ output: { city: 'Oslo' } });
        expect(results[1]).toMatchObject({ isError: true, output: expect.stringMatching(/step limit/) });
        expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: 'length' });
    });

    it('turns a provider error into an error chunk after the text already emitted', async () => {
        const model = mockModel({ script: [{ text: 'partial', error: 'rate limited' }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')] }));
        expect(textOf(chunks)).toBe('partial');
        expect(chunks[chunks.length - 1]).toEqual({ type: 'error', message: 'rate limited' });
    });

    it('closes the provider iterator when the consumer stops early', async () => {
        let closed = false;
        const model: LanguageModel = {
            provider: 'x',
            modelId: 'y',
            stream: () => ({
                [Symbol.asyncIterator]() {
                    let i = 0;
                    return {
                        next: async (): Promise<IteratorResult<ModelEvent>> => ({ value: { type: 'text-delta', delta: `t${i++} ` }, done: false }),
                        return: async (): Promise<IteratorResult<ModelEvent>> => {
                            closed = true;
                            return { value: undefined, done: true };
                        }
                    };
                }
            })
        };
        const it = streamText({ model, messages: [userMessage('x')] });
        const seen: UIChunk[] = [];
        for await (const c of it) {
            seen.push(c);
            if (seen.length === 3) break;
        }
        expect(closed).toBe(true);
        expect(seen.map((c) => c.type)).toEqual(['start', 'text', 'text']);
    });

    it('ends with a finish chunk when the signal aborts mid-stream', async () => {
        const ctrl = new AbortController();
        const model = mockModel({ script: [{ text: 'one two three four five', delayMs: 2 }] });
        const chunks: UIChunk[] = [];
        for await (const c of streamText({ model, messages: [userMessage('x')], signal: ctrl.signal })) {
            chunks.push(c);
            if (c.type === 'text') ctrl.abort();
        }
        expect(chunks.filter((c) => c.type === 'text')).toHaveLength(1);
        expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish' });
    });

    it('ends the turn promptly when aborted while a tool is still running', async () => {
        const ctrl = new AbortController();
        let toolSawAbort = false;
        const slow = defineTool({
            name: 'slow',
            description: 's',
            input: citySchema,
            execute: (_i, ctx) =>
                new Promise<string>((resolve) => {
                    ctx.signal.addEventListener('abort', () => {
                        toolSawAbort = true;
                        resolve('late');
                    });
                    setTimeout(() => resolve('done'), 5_000);
                })
        });
        const model = mockModel({ script: [{ toolCalls: [{ name: 'slow', input: { city: 'x' } }] }] });
        const started = Date.now();
        const chunks: UIChunk[] = [];
        for await (const c of streamText({ model, messages: [userMessage('x')], tools: [slow], signal: ctrl.signal })) {
            chunks.push(c);
            if (c.type === 'tool-call') setTimeout(() => ctrl.abort(), 5);
        }
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(toolSawAbort).toBe(true);
        expect(chunks.map((c) => c.type)).toEqual(['start', 'tool-call', 'finish']);
    });

    it("runs a provider generator's cleanup right after finish", async () => {
        let cleaned = false;
        const model: LanguageModel = {
            provider: 'x',
            modelId: 'y',
            stream: async function* () {
                try {
                    yield { type: 'text-delta', delta: 'hi' };
                    yield { type: 'finish', reason: 'stop' };
                } finally {
                    cleaned = true;
                }
            }
        };
        await collect(streamText({ model, messages: [userMessage('x')] }));
        expect(cleaned).toBe(true);
    });

    it('accepts an empty UI transcript (system-only first turn)', async () => {
        const model = mockModel({ script: [{ text: 'hi' }] });
        const chunks = await collect(streamText({ model, system: 'greet', messages: [] as UIMessage[] }));
        expect(model.requests[0]!.messages).toEqual([]);
        expect(textOf(chunks)).toBe('hi');
    });

    it('treats an abort with a custom reason as cancellation, not failure', async () => {
        const ctrl = new AbortController();
        const model = mockModel({ script: [{ text: 'one two three four five', delayMs: 2 }] });
        const chunks: UIChunk[] = [];
        for await (const c of streamText({ model, messages: [userMessage('x')], signal: ctrl.signal })) {
            chunks.push(c);
            if (c.type === 'text') ctrl.abort(new Error('user navigated away'));
        }
        expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish' });
        expect(chunks.some((c) => c.type === 'error')).toBe(false);
    });

    it('passes system, temperature, maxTokens and providerOptions to the model', async () => {
        const model = mockModel();
        await collect(streamText({ model, system: 'be brief', messages: [userMessage('x')], temperature: 0.2, maxTokens: 10, providerOptions: { foo: 1 } }));
        expect(model.requests[0]).toMatchObject({ system: 'be brief', temperature: 0.2, maxTokens: 10, providerOptions: { foo: 1 } });
    });
});

describe('generateText', () => {
    it('drains the stream into text, reasoning, tool calls and usage', async () => {
        const model = mockModel({
            respond: (_r, round) =>
                round === 0 ? { reasoning: 'let me see', toolCalls: [{ name: 'weather', input: { city: 'Oslo' }, id: 'c1' }] } : { text: 'Oslo: 4', usage: { outputTokens: 1 } }
        });
        const r = await generateText({ model, messages: [userMessage('x')], tools: [weather] });
        expect(r.text).toBe('Oslo: 4');
        expect(r.reasoning).toBe('let me see');
        expect(r.toolCalls).toEqual([{ id: 'c1', name: 'weather', input: { city: 'Oslo' }, output: { city: 'Oslo', tempC: 4 } }]);
        expect(r.finishReason).toBe('stop');
        expect(r.usage).toEqual({ outputTokens: 1 });
    });

    it('throws on an error chunk', async () => {
        const model = mockModel({ script: [{ error: 'nope' }] });
        await expect(generateText({ model, messages: [userMessage('x')] })).rejects.toThrow('nope');
    });
});

describe('streamObject / generateObject', () => {
    type Recipe = { title: string; steps: string[] };
    const isRecipe = (v: unknown): v is Recipe => typeof v === 'object' && v !== null && typeof (v as Recipe).title === 'string' && Array.isArray((v as Recipe).steps);
    const recipeSchema = schema(isRecipe, { type: 'object', properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['title', 'steps'] });

    it('asks the model for JSON and yields growing partials', async () => {
        const model = mockModel({ script: [{ text: '{"title": "Pancakes", "steps": ["mix", "fry"]}', chunkSize: 7 }] });
        const partials: unknown[] = [];
        for await (const c of streamObject({ model, schema: recipeSchema, messages: [userMessage('x')] })) {
            if (c.type === 'object') partials.push(c.partial);
        }
        expect(model.requests[0]!.responseFormat).toEqual({ type: 'json', schema: recipeSchema['~standard'].jsonSchema!.input({ target: 'draft-2020-12' }) });
        expect(partials.length).toBeGreaterThan(2);
        expect(partials[0]).toMatchObject({});
        expect(partials[partials.length - 1]).toEqual({ title: 'Pancakes', steps: ['mix', 'fry'] });
    });

    it('generateObject validates the final document', async () => {
        const ok = mockModel({ script: [{ text: '{"title": "T", "steps": []}' }] });
        await expect(generateObject({ model: ok, schema: recipeSchema, messages: [userMessage('x')] })).resolves.toMatchObject({ object: { title: 'T', steps: [] }, finishReason: 'stop' });
        const bad = mockModel({ script: [{ text: '{"title": 1}' }] });
        await expect(generateObject({ model: bad, schema: recipeSchema, messages: [userMessage('x')] })).rejects.toThrow(/did not match the schema/);
    });

    it('onStep observes every round', async () => {
        const onStep = vi.fn();
        const model = mockModel({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'weather', input: { city: 'A' } }] } : { text: 'done' }) });
        await collect(streamText({ model, messages: [userMessage('x')], tools: [weather], onStep }));
        expect(onStep).toHaveBeenCalledTimes(2);
        expect(onStep.mock.calls[0]![0]).toMatchObject({ step: 1, finishReason: 'tool' });
        expect(onStep.mock.calls[1]![0]).toMatchObject({ step: 2, finishReason: 'stop' });
    });
});
