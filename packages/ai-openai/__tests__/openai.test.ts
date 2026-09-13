/**
 * The OpenAI translator against RECORDED Responses API events — no network,
 * no key. A fake client stands in for `openai`'s `responses.stream`.
 *
 * The live smoke test at the bottom runs only with `OPENAI_API_KEY`.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { openai } from '@sigx/ai-openai';
import { streamText, userMessage, type ModelEvent, type ModelRequest } from '@sigx/ai';

function fakeClient(events: ResponseStreamEvent[]): { client: OpenAI; calls: unknown[] } {
    const calls: unknown[] = [];
    const client = {
        responses: {
            stream(params: unknown, opts: unknown) {
                calls.push({ params, opts });
                return (async function* () {
                    for (const e of events) yield e;
                })();
            }
        }
    } as unknown as OpenAI;
    return { client, calls };
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
    const out: ModelEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
}

const ev = <T,>(e: T): ResponseStreamEvent => e as unknown as ResponseStreamEvent;

const RECORDED: ResponseStreamEvent[] = [
    ev({ type: 'response.created', response: { id: 'resp_1' } }),
    ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } }),
    ev({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Need weather.' }),
    ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need weather.' }], encrypted_content: 'ENC' } }),
    ev({ type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
    ev({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Checking ' }),
    ev({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Oslo.' }),
    ev({ type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking Oslo.' }] } }),
    ev({ type: 'response.output_item.added', output_index: 2, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '' } }),
    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":' }),
    ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ' "Oslo"}' }),
    ev({ type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"city": "Oslo"}' }),
    ev({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 42, total_tokens: 52, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 7 } } } })
];

describe('@sigx/ai-openai', () => {
    it('translates the request: instructions, input items, tools, json schema, passthrough', async () => {
        const { client, calls } = fakeClient([ev({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: null } })]);
        const ctrl = new AbortController();
        const req: ModelRequest = {
            system: 'be brief',
            messages: [
                { role: 'user', content: 'hi' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'reasoning', text: 'x', providerData: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC' } },
                        { type: 'text', text: 'Checking.' },
                        { type: 'tool-call', id: 'call_1', name: 'weather', input: { city: 'Oslo' } }
                    ]
                },
                { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'weather', output: { tempC: 3 } }] }
            ],
            tools: [{ name: 'weather', description: 'w', inputSchema: { type: 'object' }, strict: true }],
            maxTokens: 500,
            temperature: 0.1,
            responseFormat: { type: 'json', schema: { type: 'object' }, name: 'answer' },
            signal: ctrl.signal,
            providerOptions: { store: false, reasoning: { effort: 'low' } }
        };
        await collect(openai({ client }).model('gpt-5').stream(req));
        const { params, opts } = calls[0] as { params: Record<string, unknown>; opts: { signal: AbortSignal } };
        expect(opts.signal).toBe(ctrl.signal);
        expect(params).toEqual({
            model: 'gpt-5',
            stream: true,
            instructions: 'be brief',
            max_output_tokens: 500,
            temperature: 0.1,
            store: false,
            reasoning: { effort: 'low' },
            tools: [{ type: 'function', name: 'weather', description: 'w', parameters: { type: 'object' }, strict: true }],
            text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: false } },
            input: [
                { role: 'user', content: 'hi' },
                { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC' },
                { role: 'assistant', content: 'Checking.' },
                { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"Oslo"}' },
                { type: 'function_call_output', call_id: 'call_1', output: '{"tempC":3}' }
            ]
        });
    });

    it('translates recorded events: reasoning summary, text, a function call, usage', async () => {
        const { client } = fakeClient(RECORDED);
        const events = await collect(openai({ client }).model().stream({ messages: [{ role: 'user', content: 'x' }] }));
        expect(events).toEqual([
            { type: 'reasoning-delta', delta: 'Need weather.' },
            { type: 'reasoning-end', providerData: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need weather.' }], encrypted_content: 'ENC' } },
            { type: 'text-delta', delta: 'Checking ' },
            { type: 'text-delta', delta: 'Oslo.' },
            { type: 'tool-input-delta', id: 'call_1', delta: '{"city":' },
            { type: 'tool-input-delta', id: 'call_1', delta: ' "Oslo"}' },
            { type: 'tool-call', id: 'call_1', name: 'weather', input: { city: 'Oslo' } },
            { type: 'finish', reason: 'tool', usage: { inputTokens: 10, outputTokens: 42, cacheReadInputTokens: 3, reasoningTokens: 7 } }
        ]);
    });

    it('maps incomplete (max_output_tokens) and refusal content', async () => {
        const { client: c1 } = fakeClient([ev({ type: 'response.incomplete', response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: null } })]);
        expect((await collect(openai({ client: c1 }).model().stream({ messages: [] }))).at(-1)).toMatchObject({ type: 'finish', reason: 'length' });
        const { client: c2 } = fakeClient([
            ev({ type: 'response.output_item.done', output_index: 0, item: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] } }),
            ev({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: null } })
        ]);
        expect((await collect(openai({ client: c2 }).model().stream({ messages: [] }))).at(-1)).toMatchObject({ type: 'finish', reason: 'refusal' });
    });

    it('translates image and file parts into input_image / input_file items, data as data URLs', async () => {
        const { client, calls } = fakeClient([ev({ type: 'response.completed', response: { id: 'r', status: 'completed', usage: null } })]);
        await collect(
            openai({ client })
                .model()
                .stream({
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: 'Compare these.' },
                                { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
                                { type: 'image', mediaType: 'image/jpeg', url: 'https://x.test/a.jpg' },
                                { type: 'file', mediaType: 'application/pdf', data: 'JVBERi0=', filename: 'report.pdf' },
                                { type: 'file', mediaType: 'application/pdf', url: 'https://x.test/b.pdf' },
                                { type: 'file', mediaType: 'text/plain', data: 'aGVsbG8=' }
                            ]
                        },
                        { role: 'user', content: [{ type: 'text', text: 'just ' }, { type: 'text', text: 'text' }] }
                    ]
                })
        );
        expect((calls[0] as { params: { input: unknown[] } }).params.input).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'Compare these.' },
                    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
                    { type: 'input_image', image_url: 'https://x.test/a.jpg', detail: 'auto' },
                    { type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
                    { type: 'input_file', file_url: 'https://x.test/b.pdf' },
                    { type: 'input_file', filename: 'file', file_data: 'data:text/plain;base64,aGVsbG8=' }
                ]
            },
            { role: 'user', content: 'just text' }
        ]);
    });

    it('names an unserializable tool payload instead of throwing bare', async () => {
        const { client } = fakeClient([]);
        const model = openai({ client }).model();
        await expect(
            collect(model.stream({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'call_9', name: 't', input: { n: 1n } }] }] }))
        ).rejects.toThrow(/\[sigx ai-openai\] arguments of tool call "call_9" is not JSON-serializable/);
    });

    it('surfaces failures and error events; stays silent on abort', async () => {
        const { client } = fakeClient([ev({ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'server_error', message: 'down' } } })]);
        expect(await collect(openai({ client }).model().stream({ messages: [] }))).toEqual([{ type: 'error', error: expect.objectContaining({ message: 'down' }) }]);
        const { client: c2 } = fakeClient([ev({ type: 'error', code: null, message: 'bad request', param: null })]);
        expect(await collect(openai({ client: c2 }).model().stream({ messages: [] }))).toEqual([{ type: 'error', error: expect.objectContaining({ message: 'bad request' }) }]);
        const throwing = { responses: { stream: () => (async function* () { throw new Error('boom'); })() } } as unknown as OpenAI;
        const ctrl = new AbortController();
        ctrl.abort();
        expect(await collect(openai({ client: throwing }).model().stream({ messages: [], signal: ctrl.signal }))).toEqual([]);
    });
});

describe.skipIf(!process.env.OPENAI_API_KEY)('@sigx/ai-openai (live)', () => {
    it('streams a short answer from the real API', async () => {
        const chunks: string[] = [];
        for await (const c of streamText({ model: openai().model('gpt-5-mini'), messages: [userMessage('Reply with the single word: pong')], maxTokens: 50 })) {
            if (c.type === 'text') chunks.push(c.delta);
        }
        expect(chunks.join('').toLowerCase()).toContain('pong');
    }, 30_000);
});
