/** Stream translation — `ResponseStreamEvent`s → `ModelEvent`s. */

import type OpenAI from 'openai';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { FinishReason, ModelEvent, ModelRequest, Usage } from '@sigx/ai';
import type { OpenAIProviderOptions } from './options.js';
import { toParams } from './request.js';

export async function* streamOpenAI(
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
