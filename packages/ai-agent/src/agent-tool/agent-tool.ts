/**
 * `agentTool` — an agent as a tool (delegation).
 *
 * Opens a headless session on the delegate, prompts it, and returns its
 * structured output (when an `output` schema is given) or its final text.
 * When the host is `modelAgent`, the delegate is a SUB-AGENT of the host
 * turn: an `agent-start` bound to the calling tool call, its events forwarded
 * with `parentCallId` set to that call, `agent-update`s carrying its status
 * and its own (cumulative) usage, and exactly one terminal update. The
 * delegate session is attached to the host, so a `request` it raises is
 * answered by the host's `respond()` and `cancel({ agentId })` stops it;
 * `ctx.signal` cancels it too.
 *
 * Two id spaces meet here — see `namespace.ts`: every id a forwarded event
 * carries is rewritten with the delegate's prefix, and mapped back on the way
 * in.
 */

import { defineTool, validateWith, type JsonSchema, type StandardSchemaV1, type Tool, type ToolAnnotations } from '@sigx/ai';
import type { AgentEvent, AgentStatus, ErrorInfo, PromptInput, UnstampedEvent } from '../protocol/index.js';
import { AgentError, partsText, toPromptParts } from '../protocol/index.js';
import type { Agent, SessionOptions } from '../session/index.js';
import { createReducer, createTranscript } from '../state/index.js';
import type { AgentToolContext } from '../model-agent/gate-tools.js';
import { idPrefix, namespaceEvent, ownId } from './namespace.js';

export interface AgentToolOptions<S extends StandardSchemaV1, O extends StandardSchemaV1 | undefined> {
    readonly name: string;
    readonly description: string;
    /** The sub-agent's display title on `agent-start`; default `name`. */
    readonly title?: string;
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

/**
 * Events of the delegate that make sense inside the host's turn. Not `usage`:
 * a delegate's tokens are its own, reported on its `agent-update`, never
 * summed into the host session's totals.
 */
const FORWARDED = new Set<AgentEvent['type']>(['part-start', 'part-delta', 'part-end', 'tool-call', 'tool-update', 'agent-start', 'agent-update', 'request', 'request-resolved', 'ext', 'error']);

/** How much of the prompt an `agent-start` describes. */
const DESCRIPTION_CHARS = 200;

type Terminal = { readonly status: Exclude<AgentStatus, 'running' | 'paused'>; readonly output?: unknown; readonly error?: ErrorInfo };

export function agentTool<S extends StandardSchemaV1, O extends StandardSchemaV1 | undefined = undefined>(agent: Agent, options: AgentToolOptions<S, O>): Tool<S, AgentToolResult<O>> {
    return defineTool({
        name: options.name,
        description: options.description,
        input: options.input,
        ...(options.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
        ...(options.annotations ? { annotations: options.annotations } : {}),
        ...(options.needsApproval !== undefined ? { needsApproval: options.needsApproval } : {}),
        execute: async (input, ctx) => {
            const host = ctx as Partial<AgentToolContext>;
            const emit = host.emit;
            const session = await agent.session({ interactive: false, ...options.sessionOptions, signal: ctx.signal });
            const agentId = session.id;
            const reduce = createReducer();
            const transcript = createTranscript(agentId);
            const prompt = options.prompt(input);
            // The host's gated `emit` stamps `parentCallId` with this very call —
            // an `agent-start` sits inside the call that spawned it.
            emit?.({ type: 'agent-start', agentId, callId: ctx.toolCallId, kind: options.name, title: options.title ?? options.name, description: partsText(toPromptParts(prompt)).slice(0, DESCRIPTION_CHARS) });
            // The delegate's ids reach the host prefixed (see `namespace.ts`),
            // so what comes back addressed to it is mapped back — and an id
            // that is not this delegate's is left to whoever minted it.
            const prefix = idPrefix(agentId);
            const detach =
                host.attach?.({
                    respond: async (requestId, decision) => {
                        const own = ownId(prefix, requestId);
                        if (own !== undefined) await session.respond(own, decision);
                    },
                    cancel: async (target) => {
                        if (target.agentId === undefined || target.agentId === agentId) return await session.cancel(target);
                        const own = ownId(prefix, target.agentId);
                        if (own !== undefined) await session.cancel({ ...target, agentId: own });
                    }
                }) ?? (() => {});
            emit?.({ type: 'agent-update', agentId, status: 'running' });
            const usageOf = () => ({ ...(transcript.usage ? { usage: transcript.usage } : {}), ...(transcript.costUsd !== undefined ? { costUsd: transcript.costUsd } : {}) });
            // Exactly one terminal update, whatever path ends the delegation.
            let settled = false;
            const settle = (terminal: Terminal) => {
                if (settled) return;
                settled = true;
                emit?.({ type: 'agent-update', agentId, ...usageOf(), ...terminal });
            };
            try {
                const wantsOutput = options.output !== undefined && agent.capabilities.structuredOutput;
                const turn = session.prompt(prompt, wantsOutput ? { output: { schema: options.output as StandardSchemaV1 } } : undefined);
                for await (const event of turn) {
                    reduce(transcript, event);
                    options.onEvent?.(event);
                    if (!emit) continue;
                    if (event.type === 'usage') {
                        emit({ type: 'agent-update', agentId, status: 'running', ...usageOf(), parentCallId: ctx.toolCallId });
                        continue;
                    }
                    if (FORWARDED.has(event.type)) {
                        const { sessionId: _s, epoch: _e, seq: _q, turnId: _t, ...payload } = event;
                        emit(namespaceEvent(prefix, payload as UnstampedEvent, ctx.toolCallId));
                    }
                }
                const result = await turn.result;
                if (result.stopReason === 'error') {
                    const error: ErrorInfo = result.error ?? { code: 'provider_error', message: `delegate "${agent.id}" failed` };
                    settle({ status: 'failed', error });
                    throw new AgentError(error.code, error.message);
                }
                if (result.stopReason === 'cancelled') {
                    settle({ status: 'cancelled' });
                    const err = new Error(`delegate "${agent.id}" was cancelled`);
                    err.name = 'AbortError';
                    throw err;
                }
                const text = finalText(transcript);
                if (options.output === undefined) {
                    settle({ status: 'completed', output: text });
                    return text as AgentToolResult<O>;
                }
                const raw = result.output !== undefined ? result.output : JSON.parse(text);
                const validated = (await validateWith(options.output, raw, `Delegate "${agent.id}" returned an output that does not match the schema`)) as AgentToolResult<O>;
                settle({ status: 'completed', output: validated });
                return validated;
            } catch (e) {
                // Whatever slipped past the explicit paths (a schema failure,
                // unparsable text) ends the sub-agent `failed`.
                settle({ status: 'failed', error: { code: e instanceof AgentError ? e.code : 'provider_error', message: e instanceof Error ? e.message : String(e) } });
                throw e;
            } finally {
                detach();
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
