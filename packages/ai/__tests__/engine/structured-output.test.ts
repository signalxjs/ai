/**
 * Structured output inside the tool loop — `output` on `streamText`: every
 * round asks for the JSON format, the final text is validated onto
 * `finish.output`, and failures are one `error` chunk, never a throw.
 */
import { describe, it, expect } from 'vitest';
import { streamText, generateText, defineTool, userMessage, type UIChunk } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { bareSchema, citySchema, collect, schema } from '../helpers';

const isOk = (v: unknown): v is { ok: boolean } => typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
const okJson = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const okSchema = schema(isOk, okJson, 'ok must be a boolean');

const weather = defineTool({
    name: 'weather',
    description: 'Weather for a city',
    input: citySchema,
    execute: async ({ city }) => ({ city, tempC: city.length })
});

const gated = defineTool({
    name: 'gated',
    description: 'Needs a human',
    input: citySchema,
    needsApproval: true,
    execute: async () => 'ran'
});

const finishOf = (chunks: UIChunk[]) => chunks.find((c): c is Extract<UIChunk, { type: 'finish' }> => c.type === 'finish');

describe('streamText output', () => {
    it('asks for the JSON format on every round and validates the final text onto finish.output', async () => {
        const model = mockModel({
            respond: (_req, round) => (round === 0 ? { toolCalls: [{ name: 'weather', input: { city: 'Oslo' }, id: 'c1' }] } : { text: '{"ok": true}' })
        });
        const chunks = await collect(streamText({ model, messages: [userMessage('is it ok?')], tools: [weather], output: { schema: okSchema, name: 'verdict' } }));
        expect(chunks.map((c) => c.type)).toEqual(['start', 'tool-call', 'tool-result', 'text', 'text', 'finish']);
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop', output: { ok: true } });
        expect(model.requests).toHaveLength(2);
        for (const r of model.requests) expect(r.responseFormat).toEqual({ type: 'json', schema: okJson, name: 'verdict' });
    });

    it('an object without tools; an explicit jsonSchema wins over the derived one', async () => {
        const model = mockModel({ script: [{ text: '{"ok":false}' }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], output: { schema: okSchema, jsonSchema: { type: 'object' } } }));
        expect(finishOf(chunks)?.output).toEqual({ ok: false });
        expect(model.requests[0]!.responseFormat).toEqual({ type: 'json', schema: { type: 'object' } });
    });

    it('a final text that fails validation yields one error chunk with the issues, and no finish', async () => {
        const model = mockModel({ script: [{ text: '{"ok":"yes"}' }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], output: { schema: okSchema } }));
        expect(finishOf(chunks)).toBeUndefined();
        expect(chunks.at(-1)).toEqual({ type: 'error', message: expect.stringMatching(/did not match the schema.*ok must be a boolean/) });
        expect(chunks.filter((c) => c.type === 'error')).toHaveLength(1);
    });

    it('unparseable text is an error chunk too', async () => {
        const model = mockModel({ script: [{ text: 'certainly not json' }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], output: { schema: okSchema } }));
        expect(chunks.at(-1)).toEqual({ type: 'error', message: expect.stringMatching(/no parseable JSON/) });
    });

    it('a partial JSON document is repaired before validation', async () => {
        const model = mockModel({ script: [{ text: '{"ok": true', finishReason: 'length' }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], output: { schema: okSchema } }));
        // The model ran out of tokens: the turn reports `length` and no output —
        // a truncated document is never presented as the answer.
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'length' });
    });

    it('an aborted turn finishes with other and no output', async () => {
        const ctrl = new AbortController();
        const model = mockModel({ script: [{ text: '{"ok": true}', delayMs: 2 }] });
        const chunks: UIChunk[] = [];
        for await (const c of streamText({ model, messages: [userMessage('x')], output: { schema: okSchema }, signal: ctrl.signal })) {
            chunks.push(c);
            if (c.type === 'text') ctrl.abort();
        }
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'other' });
    });

    it('a deferred approval ends with finish tool, no validation, no output', async () => {
        const model = mockModel({ script: [{ toolCalls: [{ name: 'gated', input: { city: 'Oslo' }, id: 'c1' }] }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], tools: [gated], output: { schema: okSchema }, onToolApproval: () => 'defer' }));
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'tool' });
        expect(model.requests[0]!.responseFormat).toEqual({ type: 'json', schema: okJson });
    });

    it('a refusal keeps its reason and carries no output', async () => {
        const model = mockModel({ script: [{ text: 'I cannot help with that.', finishReason: 'refusal' }] });
        const chunks = await collect(streamText({ model, messages: [userMessage('x')], output: { schema: okSchema } }));
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'refusal' });
    });

    it('throws up front when no JSON Schema can be derived', async () => {
        const model = mockModel({ script: [{ text: '{}' }] });
        await expect(collect(streamText({ model, messages: [userMessage('x')], output: { schema: bareSchema(isOk) } }))).rejects.toThrow(/\[sigx ai\] streamText: no JSON Schema/);
        expect(model.requests).toHaveLength(0);
    });

    it('generateText returns the typed output', async () => {
        const model = mockModel({
            respond: (_req, round) => (round === 0 ? { toolCalls: [{ name: 'weather', input: { city: 'Rome' }, id: 'c1' }] } : { text: '{"ok": true}' })
        });
        const r = await generateText({ model, messages: [userMessage('x')], tools: [weather], output: { schema: okSchema } });
        const ok: boolean = r.output.ok; // typed through the schema
        expect(ok).toBe(true);
        expect(r.text).toBe('{"ok": true}');
        expect(r.toolCalls).toHaveLength(1);
        const plain = await generateText({ model: mockModel({ script: [{ text: 'hi' }] }), messages: [userMessage('x')] });
        expect(plain.output).toBeUndefined();
        await expect(generateText({ model: mockModel({ script: [{ text: 'nope' }] }), messages: [userMessage('x')], output: { schema: okSchema } })).rejects.toThrow(/no parseable JSON/);
    });
});
