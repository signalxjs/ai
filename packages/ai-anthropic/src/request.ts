/** Request translation — our `ModelRequest` → `client.messages.stream` params. */

import type { ContentBlockParam, MessageCreateParamsStreaming, MessageParam, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages';
import type { ModelMessage, ModelRequest, ToolSpec } from '@sigx/ai';
import type { AnthropicProviderOptions } from './options.js';

export function toParams(modelId: string, request: ModelRequest, options: AnthropicProviderOptions): MessageCreateParamsStreaming {
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
    // Only a DECIDED value overrides the default: `null` opts out (the merge
    // loop below skips it, so no `thinking` param is sent), an object wins;
    // an explicitly `undefined` key is the same as no key.
    if (!layers.some((l) => l.thinking !== undefined)) params.thinking = { type: 'adaptive' };
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

/** `JSON.stringify` with a clear error — a BigInt or a cycle in a tool result must not surface as a bare throw mid-stream. */
function toJson(value: unknown, what: string): string {
    try {
        return JSON.stringify(value) ?? 'null';
    } catch (e) {
        throw new Error(`[sigx ai-anthropic] ${what} is not JSON-serializable: ${e instanceof Error ? e.message : String(e)}`);
    }
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
                content: typeof r.output === 'string' ? r.output : toJson(r.output ?? null, `tool result for "${r.toolCallId}"`),
                ...(r.isError ? { is_error: true } : {})
            }))
        });
    }
    return out;
}
