/**
 * @sigx/ai-openai — OpenAI as a `LanguageModel`, on the official SDK's
 * Responses API.
 *
 * A translator and nothing more: our request → `client.responses.stream`,
 * its events → `ModelEvent`. Function calls stream their arguments and are
 * emitted as one `tool-call` when done; reasoning summaries stream as
 * `reasoning-delta`. A reasoning item that carries `encrypted_content`
 * (`store: false` + `include: ['reasoning.encrypted_content']`) is kept as
 * `providerData` so a replayed transcript passes it back.
 */

import OpenAI from 'openai';
import type {
    FunctionTool,
    ResponseCreateParamsStreaming,
    ResponseInputItem,
    ResponseStreamEvent
} from 'openai/resources/responses/responses';
import type { FinishReason, LanguageModel, ModelEvent, ModelMessage, ModelRequest, ToolSpec, Usage } from '@sigx/ai';

export interface OpenAIProviderOptions {
    /** Read from `OPENAI_API_KEY` when omitted. */
    readonly apiKey?: string;
    /** A pre-built client — Azure, a proxy base URL, custom retries. */
    readonly client?: OpenAI;
    /** Merged under every request's `providerOptions`. */
    readonly defaultOptions?: Readonly<Record<string, unknown>>;
}

export interface OpenAIProvider {
    readonly client: OpenAI;
    model(modelId?: string): LanguageModel;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

export function openai(options: OpenAIProviderOptions = {}): OpenAIProvider {
    const client = options.client ?? new OpenAI(options.apiKey ? { apiKey: options.apiKey } : {});
    return {
        client,
        model(modelId = DEFAULT_OPENAI_MODEL): LanguageModel {
            return {
                provider: 'openai',
                modelId,
                stream: (request) => streamOpenAI(client, modelId, request, options)
            };
        }
    };
}

// ── Request translation ─────────────────────────────────────────────────────

function toParams(modelId: string, request: ModelRequest, options: OpenAIProviderOptions): ResponseCreateParamsStreaming {
    const passthrough = { ...options.defaultOptions, ...request.providerOptions } as Record<string, unknown>;
    const params: ResponseCreateParamsStreaming = {
        model: modelId,
        input: toInput(request.messages),
        stream: true,
        ...(request.system ? { instructions: request.system } : {}),
        ...(request.tools?.length ? { tools: request.tools.map(toTool) } : {}),
        ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseFormat
            ? {
                  text: {
                      format: {
                          type: 'json_schema',
                          name: request.responseFormat.name ?? 'output',
                          schema: request.responseFormat.schema,
                          strict: false
                      }
                  }
              }
            : {})
    };
    for (const [k, v] of Object.entries(passthrough)) {
        if (v === null || v === undefined) continue;
        (params as unknown as Record<string, unknown>)[k] = v;
    }
    return params;
}

function toTool(spec: ToolSpec): FunctionTool {
    return {
        type: 'function',
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema as FunctionTool['parameters'],
        strict: spec.strict ?? false
    };
}

function toInput(messages: readonly ModelMessage[]): ResponseInputItem[] {
    const out: ResponseInputItem[] = [];
    for (const m of messages) {
        if (m.role === 'user') {
            out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('') });
            continue;
        }
        if (m.role === 'assistant') {
            let text = '';
            for (const p of m.content) {
                if (p.type === 'text') {
                    text += p.text;
                } else if (p.type === 'reasoning') {
                    const item = p.providerData as ResponseInputItem | undefined;
                    if (item && typeof item === 'object' && (item as { type?: string }).type === 'reasoning') {
                        if (text) {
                            out.push({ role: 'assistant', content: text });
                            text = '';
                        }
                        out.push(item);
                    }
                } else {
                    if (text) {
                        out.push({ role: 'assistant', content: text });
                        text = '';
                    }
                    out.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) });
                }
            }
            if (text) out.push({ role: 'assistant', content: text });
            continue;
        }
        for (const r of m.content) {
            out.push({
                type: 'function_call_output',
                call_id: r.toolCallId,
                output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? null)
            });
        }
    }
    return out;
}

// ── Stream translation ──────────────────────────────────────────────────────

async function* streamOpenAI(
    client: OpenAI,
    modelId: string,
    request: ModelRequest,
    options: OpenAIProviderOptions
): AsyncGenerator<ModelEvent> {
    const params = toParams(modelId, request, options);
    const stream = client.responses.stream(params, request.signal ? { signal: request.signal } : undefined);

    const calls = new Map<string, { callId: string; name: string; args: string }>();
    let sawToolCall = false;
    let finish: FinishReason = 'stop';
    let usage: Usage | undefined;
    let failed: unknown;
    let inReasoning = false;

    try {
        for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
            switch (event.type) {
                case 'response.output_item.added': {
                    const item = event.item;
                    if (item.type === 'function_call') {
                        calls.set(item.id ?? item.call_id, { callId: item.call_id, name: item.name, args: '' });
                    } else if (item.type === 'reasoning') {
                        inReasoning = true;
                    }
                    break;
                }
                case 'response.output_text.delta':
                    if (event.delta) yield { type: 'text-delta', delta: event.delta };
                    break;
                case 'response.reasoning_summary_text.delta':
                case 'response.reasoning_text.delta':
                    if (event.delta) yield { type: 'reasoning-delta', delta: event.delta };
                    break;
                case 'response.function_call_arguments.delta': {
                    const c = calls.get(event.item_id);
                    if (c) {
                        c.args += event.delta;
                        yield { type: 'tool-input-delta', id: c.callId, delta: event.delta };
                    }
                    break;
                }
                case 'response.function_call_arguments.done': {
                    const c = calls.get(event.item_id);
                    if (!c) break;
                    calls.delete(event.item_id);
                    let input: unknown = {};
                    const raw = event.arguments || c.args;
                    if (raw.trim()) {
                        try {
                            input = JSON.parse(raw);
                        } catch (e) {
                            yield { type: 'error', error: new Error(`[sigx ai-openai] tool "${c.name}" arguments were not valid JSON: ${(e as Error).message}`) };
                            return;
                        }
                    }
                    sawToolCall = true;
                    yield { type: 'tool-call', id: c.callId, name: c.name, input };
                    break;
                }
                case 'response.output_item.done': {
                    const item = event.item;
                    if (item.type === 'reasoning' && inReasoning) {
                        inReasoning = false;
                        yield item.encrypted_content ? { type: 'reasoning-end', providerData: item } : { type: 'reasoning-end' };
                    } else if (item.type === 'message') {
                        for (const c of item.content) {
                            if (c.type === 'refusal') finish = 'refusal';
                        }
                    }
                    break;
                }
                case 'response.completed':
                case 'response.incomplete': {
                    const r = event.response;
                    const u = r.usage;
                    if (u) {
                        usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
                        if (u.input_tokens_details?.cached_tokens !== undefined) usage.cacheReadInputTokens = u.input_tokens_details.cached_tokens;
                        if (u.output_tokens_details?.reasoning_tokens !== undefined) usage.reasoningTokens = u.output_tokens_details.reasoning_tokens;
                    }
                    if (event.type === 'response.incomplete') {
                        finish = r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : r.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'other';
                    }
                    break;
                }
                case 'response.failed':
                    failed = new Error(event.response.error?.message ?? 'The response failed.');
                    break;
                case 'error':
                    failed = new Error(event.message);
                    break;
                default:
                    break;
            }
            if (failed !== undefined) break;
        }
    } catch (e) {
        if (request.signal?.aborted) return;
        yield { type: 'error', error: e };
        return;
    }
    if (failed !== undefined) {
        yield { type: 'error', error: failed };
        return;
    }
    if (sawToolCall && finish === 'stop') finish = 'tool';
    yield { type: 'finish', reason: finish, ...(usage ? { usage } : {}) };
}
