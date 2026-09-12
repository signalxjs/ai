/** Stream translation — `MessageStreamEvent`s → `ModelEvent`s. */

import type Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamEvent, StopReason } from '@anthropic-ai/sdk/resources/messages';
import type { FinishReason, ModelEvent, ModelRequest, Usage } from '@sigx/ai';
import type { AnthropicProviderOptions } from './options.js';
import { toParams } from './request.js';

function toFinish(reason: StopReason | null | undefined): FinishReason {
    switch (reason) {
        case 'end_turn':
        case 'stop_sequence':
        case 'pause_turn':
            return 'stop';
        case 'max_tokens':
        case 'model_context_window_exceeded':
            return 'length';
        case 'tool_use':
            return 'tool';
        case 'refusal':
            return 'refusal';
        default:
            return 'other';
    }
}

function num(v: number | null | undefined): number | undefined {
    return typeof v === 'number' ? v : undefined;
}

export async function* streamClaude(
    client: Anthropic,
    modelId: string,
    request: ModelRequest,
    options: AnthropicProviderOptions
): AsyncGenerator<ModelEvent> {
    const params = toParams(modelId, request, options);
    const stream = client.messages.stream(params, request.signal ? { signal: request.signal } : undefined);

    type Open = { kind: 'text' } | { kind: 'thinking'; thinking: string; signature: string } | { kind: 'tool'; id: string; name: string; json: string };
    const open = new Map<number, Open>();
    const usage: Usage = {};
    let stop: StopReason | null = null;

    try {
        for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
            switch (event.type) {
                case 'message_start': {
                    const u = event.message.usage;
                    usage.inputTokens = u.input_tokens;
                    if (num(u.cache_read_input_tokens) !== undefined) usage.cacheReadInputTokens = u.cache_read_input_tokens!;
                    if (num(u.cache_creation_input_tokens) !== undefined) usage.cacheCreationInputTokens = u.cache_creation_input_tokens!;
                    break;
                }
                case 'content_block_start': {
                    const b = event.content_block;
                    if (b.type === 'text') open.set(event.index, { kind: 'text' });
                    else if (b.type === 'thinking') open.set(event.index, { kind: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' });
                    else if (b.type === 'redacted_thinking') yield { type: 'reasoning-end', providerData: { type: 'redacted_thinking', data: b.data } };
                    else if (b.type === 'tool_use') open.set(event.index, { kind: 'tool', id: b.id, name: b.name, json: '' });
                    break;
                }
                case 'content_block_delta': {
                    const o = open.get(event.index);
                    const d = event.delta;
                    if (d.type === 'text_delta') {
                        if (d.text) yield { type: 'text-delta', delta: d.text };
                    } else if (d.type === 'thinking_delta') {
                        if (o?.kind === 'thinking') o.thinking += d.thinking;
                        if (d.thinking) yield { type: 'reasoning-delta', delta: d.thinking };
                    } else if (d.type === 'signature_delta') {
                        if (o?.kind === 'thinking') o.signature += d.signature;
                    } else if (d.type === 'input_json_delta') {
                        if (o?.kind === 'tool') {
                            o.json += d.partial_json;
                            yield { type: 'tool-input-delta', id: o.id, delta: d.partial_json };
                        }
                    }
                    break;
                }
                case 'content_block_stop': {
                    const o = open.get(event.index);
                    open.delete(event.index);
                    if (!o) break;
                    if (o.kind === 'thinking') {
                        yield { type: 'reasoning-end', providerData: { type: 'thinking', thinking: o.thinking, signature: o.signature } };
                    } else if (o.kind === 'tool') {
                        let input: unknown = {};
                        if (o.json.trim()) {
                            try {
                                input = JSON.parse(o.json);
                            } catch (e) {
                                yield { type: 'error', error: new Error(`[sigx ai-anthropic] tool "${o.name}" arguments were not valid JSON: ${(e as Error).message}`) };
                                return;
                            }
                        }
                        yield { type: 'tool-call', id: o.id, name: o.name, input };
                    }
                    break;
                }
                case 'message_delta': {
                    stop = event.delta.stop_reason ?? stop;
                    const u = event.usage;
                    if (u) {
                        usage.outputTokens = u.output_tokens;
                        if (num(u.input_tokens) !== undefined) usage.inputTokens = u.input_tokens!;
                        if (num(u.cache_read_input_tokens) !== undefined) usage.cacheReadInputTokens = u.cache_read_input_tokens!;
                        if (num(u.cache_creation_input_tokens) !== undefined) usage.cacheCreationInputTokens = u.cache_creation_input_tokens!;
                        if (u.output_tokens_details?.thinking_tokens !== undefined) usage.reasoningTokens = u.output_tokens_details.thinking_tokens;
                    }
                    break;
                }
                case 'message_stop':
                    break;
                default:
                    break;
            }
        }
    } catch (e) {
        if (request.signal?.aborted) return;
        yield { type: 'error', error: e };
        return;
    }
    yield { type: 'finish', reason: toFinish(stop), usage };
}
