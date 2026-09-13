/**
 * The Anthropic translator against RECORDED stream events — no network, no
 * key. A fake client stands in for `@anthropic-ai/sdk`'s `messages.stream`
 * and captures the params it was given, so both directions are checked:
 * our request → SDK params, SDK events → `ModelEvent`s.
 *
 * The live smoke test at the bottom runs only with `ANTHROPIC_API_KEY`.
 */
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import { anthropic } from '@sigx/ai-anthropic';
import { generateText, streamText, userMessage, type ModelEvent, type ModelRequest, type StandardSchemaV1, type UIChunk } from '@sigx/ai';

async function collectChunks(it: AsyncIterable<UIChunk>): Promise<UIChunk[]> {
    const out: UIChunk[] = [];
    for await (const c of it) out.push(c);
    return out;
}

function fakeClient(events: MessageStreamEvent[]): { client: Anthropic; calls: unknown[] } {
    const calls: unknown[] = [];
    const client = {
        messages: {
            stream(params: unknown, opts: unknown) {
                calls.push({ params, opts });
                return (async function* () {
                    for (const e of events) yield e;
                })();
            }
        }
    } as unknown as Anthropic;
    return { client, calls };
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
    const out: ModelEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
}

const start = (input_tokens = 10): MessageStreamEvent =>
    ({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: null } } }) as unknown as MessageStreamEvent;

const RECORDED_TEXT_AND_TOOL: MessageStreamEvent[] = [
    start(),
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the weather.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Oslo.' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} } } as unknown as MessageStreamEvent,
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' "Oslo"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null, container: null, stop_details: null }, usage: { output_tokens: 42, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, server_tool_use: null, output_tokens_details: { thinking_tokens: 7 } } } as unknown as MessageStreamEvent,
    { type: 'message_stop' }
];

describe('@sigx/ai-anthropic', () => {
    it('translates the request: system, messages, tools, adaptive thinking, passthrough', async () => {
        const { client, calls } = fakeClient([start(), { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, container: null, stop_details: null }, usage: { output_tokens: 1 } } as unknown as MessageStreamEvent, { type: 'message_stop' }]);
        const model = anthropic({ client, defaultOptions: { output_config: { effort: 'low' } } }).model('claude-opus-5');
        const ctrl = new AbortController();
        const req: ModelRequest = {
            system: 'be brief',
            messages: [
                { role: 'user', content: 'hi' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'reasoning', text: 'x', providerData: { type: 'thinking', thinking: 'x', signature: 'SIG' } },
                        { type: 'reasoning', text: 'unsigned — dropped' },
                        { type: 'text', text: 'Checking.' },
                        { type: 'tool-call', id: 'toolu_1', name: 'weather', input: { city: 'Oslo' } }
                    ]
                },
                { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_1', toolName: 'weather', output: { tempC: 3 } }, { type: 'tool-result', toolCallId: 'toolu_2', toolName: 'weather', output: 'boom', isError: true }] }
            ],
            tools: [{ name: 'weather', description: 'w', inputSchema: { type: 'object' }, strict: true }],
            maxTokens: 500,
            temperature: 0.1,
            signal: ctrl.signal,
            providerOptions: { output_config: { format: { type: 'json_schema', schema: { type: 'object' } } }, thinking: { type: 'adaptive', display: 'summarized' } }
        };
        await collect(model.stream(req));
        const { params, opts } = calls[0] as { params: Record<string, unknown>; opts: { signal: AbortSignal } };
        expect(opts.signal).toBe(ctrl.signal);
        expect(params).toEqual({
            model: 'claude-opus-5',
            max_tokens: 500,
            stream: true,
            system: 'be brief',
            temperature: 0.1,
            tools: [{ name: 'weather', description: 'w', input_schema: { type: 'object' }, strict: true }],
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
            messages: [
                { role: 'user', content: 'hi' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'thinking', thinking: 'x', signature: 'SIG' },
                        { type: 'text', text: 'Checking.' },
                        { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Oslo' } }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"tempC":3}' },
                        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }
                    ]
                }
            ]
        });
    });

    it('defaults to adaptive thinking and 64000 max_tokens; `thinking: null` opts out', async () => {
        const { client, calls } = fakeClient([start(), { type: 'message_stop' }]);
        const p = anthropic({ client });
        await collect(p.model().stream({ messages: [{ role: 'user', content: 'x' }] }));
        expect(calls[0]).toMatchObject({ params: { model: 'claude-opus-5', max_tokens: 64000, thinking: { type: 'adaptive' } } });
        await collect(p.model('claude-haiku-4-5').stream({ messages: [{ role: 'user', content: 'x' }], providerOptions: { thinking: null } }));
        expect((calls[1] as { params: Record<string, unknown> }).params).not.toHaveProperty('thinking');
        // An explicitly undefined key is not a decision — the default stands.
        await collect(p.model().stream({ messages: [{ role: 'user', content: 'x' }], providerOptions: { thinking: undefined } }));
        expect(calls[2]).toMatchObject({ params: { thinking: { type: 'adaptive' } } });
    });

    it('translates recorded events: thinking with signature, text, a tool call, usage, stop reason', async () => {
        const { client } = fakeClient(RECORDED_TEXT_AND_TOOL);
        const events = await collect(anthropic({ client }).model().stream({ messages: [{ role: 'user', content: 'x' }] }));
        expect(events).toEqual([
            { type: 'reasoning-delta', delta: 'Need the weather.' },
            { type: 'reasoning-end', providerData: { type: 'thinking', thinking: 'Need the weather.', signature: 'SIG' } },
            { type: 'text-delta', delta: 'Checking ' },
            { type: 'text-delta', delta: 'Oslo.' },
            { type: 'tool-input-delta', id: 'toolu_1', delta: '{"city":' },
            { type: 'tool-input-delta', id: 'toolu_1', delta: ' "Oslo"}' },
            { type: 'tool-call', id: 'toolu_1', name: 'weather', input: { city: 'Oslo' } },
            { type: 'finish', reason: 'tool', usage: { inputTokens: 10, cacheReadInputTokens: 3, outputTokens: 42, reasoningTokens: 7 } }
        ]);
    });

    it('maps refusal and max_tokens stop reasons', async () => {
        for (const [stop, reason] of [['refusal', 'refusal'], ['max_tokens', 'length'], ['end_turn', 'stop']] as const) {
            const { client } = fakeClient([start(), { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, container: null, stop_details: null }, usage: { output_tokens: 1 } } as unknown as MessageStreamEvent]);
            const events = await collect(anthropic({ client }).model().stream({ messages: [{ role: 'user', content: 'x' }] }));
            expect(events.at(-1)).toMatchObject({ type: 'finish', reason });
        }
    });

    it('translates image and file parts: base64 and URL sources, documents with a title, text files as text', async () => {
        const { client, calls } = fakeClient([start(), { type: 'message_stop' }]);
        await collect(
            anthropic({ client })
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
                                { type: 'file', mediaType: 'text/plain', data: 'aGVsbG8=', filename: 'notes.txt' }
                            ]
                        }
                    ]
                })
        );
        expect((calls[0] as { params: { messages: unknown[] } }).params.messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Compare these.' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
                    { type: 'image', source: { type: 'url', url: 'https://x.test/a.jpg' } },
                    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'report.pdf' },
                    { type: 'document', source: { type: 'url', url: 'https://x.test/b.pdf' } },
                    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello' }, title: 'notes.txt' }
                ]
            }
        ]);
    });

    it('rejects an unsupported image or document media type at request time, surfacing as one error chunk', async () => {
        const { client } = fakeClient([start(), { type: 'message_stop' }]);
        const model = anthropic({ client }).model();
        await expect(collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/bmp', data: 'AAAA' }] }] }))).rejects.toThrow(
            /\[sigx ai-anthropic\] image media type "image\/bmp" is not supported \(image\/jpeg, image\/png, image\/gif, image\/webp\)/
        );
        await expect(collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'text/csv', data: 'AAAA' }] }] }))).rejects.toThrow(
            /\[sigx ai-anthropic\] document media type "text\/csv" is not supported \(application\/pdf, text\/plain\)/
        );
        // The same check applies to URL sources, and a part with neither data nor url is a caller error.
        await expect(collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/bmp', url: 'https://x.test/a.bmp' }] }] }))).rejects.toThrow(/image\/bmp/);
        await expect(collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'text/csv', url: 'https://x.test/a.csv' }] }] }))).rejects.toThrow(/text\/csv/);
        await expect(collect(model.stream({ messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png' }] }] }))).rejects.toThrow(/\[sigx ai-anthropic\] image part needs data or url/);
        const chunks = await collectChunks(streamText({ model, messages: [{ id: 'u', role: 'user', parts: [{ type: 'image', mediaType: 'image/bmp', data: 'AAAA' }] }] }));
        expect(chunks.map((c) => c.type)).toEqual(['start', 'error']);
        expect(chunks[1]).toMatchObject({ type: 'error', message: expect.stringContaining('image/bmp') });
    });

    it('names an unserializable tool result instead of throwing bare', async () => {
        const { client } = fakeClient([]);
        const model = anthropic({ client }).model();
        await expect(
            collect(model.stream({ messages: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_9', toolName: 't', output: { n: 1n } }] }] }))
        ).rejects.toThrow(/\[sigx ai-anthropic\] tool result for "toolu_9" is not JSON-serializable/);
    });

    it('surfaces an SDK throw as an error event (and stays silent on abort)', async () => {
        const client = { messages: { stream: () => (async function* () { throw new Error('429 rate limited'); })() } } as unknown as Anthropic;
        const events = await collect(anthropic({ client }).model().stream({ messages: [{ role: 'user', content: 'x' }] }));
        expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ message: '429 rate limited' }) }]);
        const ctrl = new AbortController();
        ctrl.abort();
        const aborted = await collect(anthropic({ client }).model().stream({ messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }));
        expect(aborted).toEqual([]);
    });

    it('drives the whole engine: the thinking block is replayed on the second round', async () => {
        const rounds = [
            RECORDED_TEXT_AND_TOOL,
            [start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } } as MessageStreamEvent, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '3°C in Oslo.' } } as MessageStreamEvent, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } as unknown as MessageStreamEvent]
        ];
        const calls: Array<{ params: { messages: unknown[] } }> = [];
        const client = { messages: { stream(params: { messages: unknown[] }) { calls.push({ params }); const ev = rounds[calls.length - 1]!; return (async function* () { yield* ev; })(); } } } as unknown as Anthropic;
        const { defineTool } = await import('@sigx/ai');
        const citySchema: StandardSchemaV1<{ city: string }, { city: string }> = {
            '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v as { city: string } }) }
        };
        const weather = defineTool({
            name: 'weather',
            description: 'w',
            input: citySchema,
            jsonSchema: { type: 'object' },
            execute: async ({ city }) => ({ city, tempC: 3 })
        });
        const r = await generateText({ model: anthropic({ client }).model(), messages: [userMessage('weather in Oslo?')], tools: [weather] });
        expect(r.text).toBe('Checking Oslo.3°C in Oslo.');
        expect(r.toolCalls).toEqual([{ id: 'toolu_1', name: 'weather', input: { city: 'Oslo' }, output: { city: 'Oslo', tempC: 3 } }]);
        expect(r.usage).toEqual({ inputTokens: 20, cacheReadInputTokens: 6, outputTokens: 47, reasoningTokens: 7 });
        // Round 2 replays the signed thinking block verbatim, ahead of the text and tool_use.
        expect(calls[1]!.params.messages[1]).toEqual({
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'Need the weather.', signature: 'SIG' },
                { type: 'text', text: 'Checking Oslo.' },
                { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Oslo' } }
            ]
        });
        expect(calls[1]!.params.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"city":"Oslo","tempC":3}' }] });
    });

    it('sends tools and a JSON response format in ONE request (structured output inside the tool loop)', async () => {
        const { client, calls } = fakeClient([
            start(),
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, container: null, stop_details: null }, usage: { output_tokens: 1, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, server_tool_use: null } } as unknown as MessageStreamEvent,
            { type: 'message_stop' }
        ]);
        const req: ModelRequest = {
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'weather', description: 'w', inputSchema: { type: 'object' } }],
            responseFormat: { type: 'json', schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, name: 'verdict' }
        };
        await collect(anthropic({ client }).model('claude-opus-5').stream(req));
        const { params } = calls[0] as { params: Record<string, unknown> };
        expect(params.tools).toEqual([{ name: 'weather', description: 'w', input_schema: { type: 'object' } }]);
        expect(params.output_config).toEqual({ format: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } });
    });
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('@sigx/ai-anthropic (live)', () => {
    it('streams a short answer from the real API', async () => {
        const chunks: string[] = [];
        for await (const c of streamText({ model: anthropic().model('claude-haiku-4-5'), messages: [userMessage('Reply with the single word: pong')], maxTokens: 50 })) {
            if (c.type === 'text') chunks.push(c.delta);
        }
        expect(chunks.join('').toLowerCase()).toContain('pong');
    }, 30_000);
});
