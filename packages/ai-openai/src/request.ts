/** Request translation — our `ModelRequest` → `client.responses.stream` params. */

import type { FunctionTool, ResponseCreateParamsStreaming, ResponseInputItem } from 'openai/resources/responses/responses';
import type { ModelMessage, ModelRequest, ToolSpec } from '@sigx/ai';
import type { OpenAIProviderOptions } from './options.js';

export function toParams(modelId: string, request: ModelRequest, options: OpenAIProviderOptions): ResponseCreateParamsStreaming {
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

/** `JSON.stringify` with a clear error — a BigInt or a cycle in a tool payload must not surface as a bare throw mid-stream. */
function toJson(value: unknown, what: string): string {
    try {
        return JSON.stringify(value) ?? 'null';
    } catch (e) {
        throw new Error(`[sigx ai-openai] ${what} is not JSON-serializable: ${e instanceof Error ? e.message : String(e)}`);
    }
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
                    out.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: toJson(p.input ?? {}, `arguments of tool call "${p.id}"`) });
                }
            }
            if (text) out.push({ role: 'assistant', content: text });
            continue;
        }
        for (const r of m.content) {
            out.push({
                type: 'function_call_output',
                call_id: r.toolCallId,
                output: typeof r.output === 'string' ? r.output : toJson(r.output ?? null, `tool result for "${r.toolCallId}"`)
            });
        }
    }
    return out;
}
