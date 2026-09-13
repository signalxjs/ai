/**
 * `agentTool` — an agent as a tool (delegation).
 *
 * Opens a headless session on the delegate, prompts it, and returns its
 * structured output (when an `output` schema is given) or its final text.
 * When the host is `modelAgent`, the delegate's events are forwarded into
 * the host turn with `parentCallId` set to the calling tool call, so a UI
 * can show the nested work; `ctx.signal` cancels the delegate.
 */

import { defineTool, validateWith, type JsonSchema, type StandardSchemaV1, type Tool, type ToolAnnotations } from '@sigx/ai';
import type { AgentEvent, PromptInput, UnstampedEvent } from '../protocol/index.js';
import { AgentError } from '../protocol/index.js';
import type { Agent, SessionOptions } from '../session/index.js';
import { createReducer, createTranscript } from '../state/index.js';
import type { AgentToolContext } from '../model-agent/gate-tools.js';

export interface AgentToolOptions<S extends StandardSchemaV1, O extends StandardSchemaV1 | undefined> {
    readonly name: string;
    readonly description: string;
    readonly input: S;
    readonly jsonSchema?: JsonSchema;
    /** Validated against the delegate's structured output (or its final text parsed as JSON). */
    readonly output?: O;
    /** Merged into the delegate session's options (`interactive: false` unless overridden). */
    readonly sessionOptions?: SessionOptions;
    readonly prompt: (input: StandardSchemaV1.InferOutput<S>) => PromptInput;
    /** Observe every delegate event (in addition to the nested forwarding). */
    readonly onEvent?: (event: AgentEvent) => void;
    readonly annotations?: ToolAnnotations;
    readonly needsApproval?: boolean;
}

export type AgentToolResult<O extends StandardSchemaV1 | undefined> = O extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<O> : string;

/** Events of the delegate that make sense inside the host's turn. */
const FORWARDED = new Set<AgentEvent['type']>(['part-start', 'part-delta', 'part-end', 'tool-call', 'tool-update', 'request', 'request-resolved', 'ext', 'usage', 'error']);

export function agentTool<S extends StandardSchemaV1, O extends StandardSchemaV1 | undefined = undefined>(agent: Agent, options: AgentToolOptions<S, O>): Tool<S, AgentToolResult<O>> {
    return defineTool({
        name: options.name,
        description: options.description,
        input: options.input,
        ...(options.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
        ...(options.annotations ? { annotations: options.annotations } : {}),
        ...(options.needsApproval !== undefined ? { needsApproval: options.needsApproval } : {}),
        execute: async (input, ctx) => {
            const emit = (ctx as Partial<AgentToolContext>).emit;
            const session = await agent.session({ interactive: false, ...options.sessionOptions, signal: ctx.signal });
            const reduce = createReducer();
            const transcript = createTranscript(session.id);
            try {
                const wantsOutput = options.output !== undefined && agent.capabilities.structuredOutput;
                const turn = session.prompt(options.prompt(input), wantsOutput ? { output: { schema: options.output as StandardSchemaV1 } } : undefined);
                for await (const event of turn) {
                    reduce(transcript, event);
                    options.onEvent?.(event);
                    if (emit && FORWARDED.has(event.type)) {
                        const { sessionId: _s, epoch: _e, seq: _q, turnId: _t, ...payload } = event;
                        emit({ ...(payload as UnstampedEvent), parentCallId: event.parentCallId ?? ctx.toolCallId });
                    }
                }
                const result = await turn.result;
                if (result.stopReason === 'error') throw new AgentError(result.error?.code ?? 'provider_error', result.error?.message ?? `delegate "${agent.id}" failed`);
                if (result.stopReason === 'cancelled') {
                    const err = new Error(`delegate "${agent.id}" was cancelled`);
                    err.name = 'AbortError';
                    throw err;
                }
                const text = finalText(transcript);
                if (options.output === undefined) return text as AgentToolResult<O>;
                const raw = result.output !== undefined ? result.output : JSON.parse(text);
                return (await validateWith(options.output, raw, `Delegate "${agent.id}" returned an output that does not match the schema`)) as AgentToolResult<O>;
            } finally {
                await session.close().catch(() => {});
            }
        }
    }) as Tool<S, AgentToolResult<O>>;
}

function finalText(transcript: ReturnType<typeof createTranscript>): string {
    let out = '';
    for (const m of transcript.messages) {
        if (m.role !== 'assistant' || m.parentCallId !== undefined) continue;
        for (const p of m.parts) if (p.type === 'text') out += p.text;
    }
    return out;
}
