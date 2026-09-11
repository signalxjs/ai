/**
 * @sigx/ai-anthropic — Claude as a `LanguageModel`, on the official SDK.
 *
 * A translator and nothing more: our request → `client.messages.stream`,
 * its events → `ModelEvent`. Thinking blocks come back as `reasoning`
 * parts whose `providerData` is the signed block, so a transcript replayed
 * on the same model passes them back exactly as received (which tool use
 * with thinking requires). Adaptive thinking is the default; a caller who
 * wants readable reasoning passes `thinking: { type: 'adaptive', display:
 * 'summarized' }` through `providerOptions`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
    ContentBlockParam,
    MessageCreateParamsStreaming,
    MessageParam,
    MessageStreamEvent,
    StopReason,
    Tool as AnthropicTool
} from '@anthropic-ai/sdk/resources/messages';
import type { FinishReason, LanguageModel, ModelEvent, ModelMessage, ModelRequest, ToolSpec, Usage } from '@sigx/ai';

export interface AnthropicProviderOptions {
    /** Read from `ANTHROPIC_API_KEY` (or an `ant auth login` profile) when omitted. */
    readonly apiKey?: string;
    /** A pre-built client — Vertex, Bedrock Mantle, Foundry, or one with custom retries. */
    readonly client?: Anthropic;
    /** Merged under every request's `providerOptions`. */
    readonly defaultOptions?: Readonly<Record<string, unknown>>;
    /** `max_tokens` when a request does not say; default 64000. */
    readonly defaultMaxTokens?: number;
}

export interface AnthropicProvider {
    readonly client: Anthropic;
    model(modelId?: string): LanguageModel;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export function anthropic(options: AnthropicProviderOptions = {}): AnthropicProvider {
    const client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    return {
        client,
        model(modelId = DEFAULT_ANTHROPIC_MODEL): LanguageModel {
            return {
                provider: 'anthropic',
                modelId,
                stream: (request) => streamClaude(client, modelId, request, options)
            };
        }
    };
}

// ── Request translation ─────────────────────────────────────────────────────

function toParams(modelId: string, request: ModelRequest, options: AnthropicProviderOptions): MessageCreateParamsStreaming {
    // Provider defaults first, then the request's — each layer merges
    // `output_config` field by field (effort from one, format from another)
    // and replaces anything else whole.
    const layers = [options.defaultOptions ?? {}, request.providerOptions ?? {}] as Record<string, unknown>[];
    const params: MessageCreateParamsStreaming = {
        model: modelId,
        max_tokens: request.maxTokens ?? options.defaultMaxTokens ?? 64000,
        messages: toMessages(request.messages),
        stream: true,
        ...(request.system ? { system: request.system } : {}),
        ...(request.tools?.length ? { tools: request.tools.map(toTool) } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseFormat
            ? { output_config: { format: { type: 'json_schema', schema: request.responseFormat.schema } } }
            : {})
    };
    // Adaptive thinking unless the caller decided otherwise. `null` opts out
    // entirely (a model that rejects the parameter).
    if (!layers.some((l) => 'thinking' in l)) params.thinking = { type: 'adaptive' };
    for (const layer of layers) {
        for (const [k, v] of Object.entries(layer)) {
            if (v === null || v === undefined) continue;
            if (k === 'output_config') {
                params.output_config = { ...params.output_config, ...(v as object) };
                continue;
            }
            (params as unknown as Record<string, unknown>)[k] = v;
        }
    }
    return params;
}

function toTool(spec: ToolSpec): AnthropicTool {
    return {
        name: spec.name,
        description: spec.description,
        input_schema: spec.inputSchema as AnthropicTool['input_schema'],
        ...(spec.strict !== undefined ? { strict: spec.strict } : {})
    };
}

function toMessages(messages: readonly ModelMessage[]): MessageParam[] {
    const out: MessageParam[] = [];
    for (const m of messages) {
        if (m.role === 'user') {
            out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map((p) => ({ type: 'text' as const, text: p.text })) });
            continue;
        }
        if (m.role === 'assistant') {
            const content: ContentBlockParam[] = [];
            for (const p of m.content) {
                if (p.type === 'text') {
                    if (p.text) content.push({ type: 'text', text: p.text });
                } else if (p.type === 'reasoning') {
                    // Only a signed block can be replayed; bare text is dropped.
                    const block = p.providerData as ContentBlockParam | undefined;
                    if (block && typeof block === 'object' && (block.type === 'thinking' || block.type === 'redacted_thinking')) content.push(block);
                } else {
                    content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} });
                }
            }
            if (content.length) out.push({ role: 'assistant', content });
            continue;
        }
        // Tool results: ONE user message per assistant round, results in order.
        out.push({
            role: 'user',
            content: m.content.map((r) => ({
                type: 'tool_result' as const,
                tool_use_id: r.toolCallId,
                content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? null),
                ...(r.isError ? { is_error: true } : {})
            }))
        });
    }
    return out;
}

// ── Stream translation ──────────────────────────────────────────────────────

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

async function* streamClaude(
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
