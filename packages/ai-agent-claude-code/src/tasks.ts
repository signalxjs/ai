/**
 * Claude Code tasks → sub-agents. The CLI reports a spawned agent (or a
 * workflow run) as a task: `system/task_started` when it begins,
 * `task_progress` / `task_updated` while it runs, `task_notification` when
 * it is over, and the Task tool's own `tool_use_result` (an `AgentOutput`)
 * when a foreground agent's call settles. This tracker folds all of that
 * onto `agent-start` / `agent-update` — one start per agent, one terminal
 * update per agent, whichever frame says so first — and remembers the
 * agent type so nested parts can name their actor.
 *
 * It is SESSION-scoped, not turn-scoped: a background agent outlives the
 * turn that spawned it, its frames arrive between turns, and it ends only
 * with a notification, a `stopTask`, or the session closing.
 *
 * Not every task is an agent. A backgrounded Bash command, an MCP task or an
 * ambient watcher stays an `ext` frame — the caller maps those itself.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Usage } from '@sigx/ai';
import type { AgentStatus, UnstampedEvent } from '@sigx/ai-agent';

export type Emit = (event: UnstampedEvent) => void;

export type TaskKind = 'subagent' | 'workflow';

export interface TrackedAgent {
    readonly agentId: string;
    /** The Task / Workflow tool call that spawned it; absent for a task the CLI started on its own. */
    readonly callId?: string;
    readonly kind: TaskKind;
    /** The sub-agent type Claude Code named — what nested parts carry as `actor`. */
    readonly actor?: string;
    background: boolean;
    terminal: boolean;
}

export interface AgentTracker {
    /** `task_*` system frames → agent events. `false` when the frame is not about a sub-agent (the caller maps it as an `ext`). */
    handleTask(message: SDKMessage, emit: Emit, knownCall?: (callId: string) => boolean): boolean;
    /** The spawning call's `tool_result` (and its `AgentOutput`, when the CLI attached one) settles a foreground agent or moves it to the background. */
    settleCall(callId: string, toolUseResult: unknown, text: string, isError: boolean, emit: Emit): void;
    /** The actor for parts produced inside `callId`. */
    actorFor(callId: string | null | undefined): string | undefined;
    get(agentId: string): TrackedAgent | undefined;
    /** Every agent still running ends with `status`; `background: false` leaves background agents alone. */
    sweep(status: 'cancelled' | 'failed', emit: Emit, options?: { readonly background?: boolean; readonly message?: string }): void;
}

type Frame = { readonly type: string; readonly subtype?: string } & Record<string, unknown>;

/** Which sub-agent a task is — or `undefined` when it is not one. */
export function taskKind(frame: Record<string, unknown>): TaskKind | undefined {
    if (frame.ambient === true || frame.skip_transcript === true) return undefined;
    const type = frame.task_type;
    if (type === 'local_workflow') return 'workflow';
    if (type === 'local_agent') return 'subagent';
    if (type === undefined && typeof frame.subagent_type === 'string') return 'subagent';
    return undefined;
}

const TERMINAL: Record<string, AgentStatus> = { completed: 'completed', failed: 'failed', stopped: 'cancelled', killed: 'cancelled' };

export function createAgentTracker(): AgentTracker {
    const agents = new Map<string, TrackedAgent>();
    const byCall = new Map<string, string>();

    const context = (agent: TrackedAgent) => (agent.callId !== undefined ? { parentCallId: agent.callId } : {});
    const totals = (usage: unknown): Usage | undefined => {
        const total = (usage as { total_tokens?: unknown } | undefined)?.total_tokens;
        return typeof total === 'number' ? { totalTokens: total } : undefined;
    };
    const end = (agent: TrackedAgent, status: AgentStatus, extra: Record<string, unknown>, emit: Emit) => {
        if (agent.terminal) return;
        agent.terminal = true;
        emit({ type: 'agent-update', agentId: agent.agentId, status, ...extra, ...context(agent) } as UnstampedEvent);
    };
    const update = (agent: TrackedAgent, status: AgentStatus, extra: Record<string, unknown>, emit: Emit) => {
        if (agent.terminal) return;
        emit({ type: 'agent-update', agentId: agent.agentId, status, ...extra, ...context(agent) } as UnstampedEvent);
    };

    return {
        handleTask(message, emit, knownCall) {
            const m = message as unknown as Frame;
            if (m.type !== 'system' || typeof m.task_id !== 'string') return false;
            const agentId = m.task_id;
            switch (m.subtype) {
                case 'task_started': {
                    const kind = taskKind(m);
                    if (!kind) return false;
                    if (agents.has(agentId)) return true;
                    const toolUseId = typeof m.tool_use_id === 'string' && (!knownCall || knownCall(m.tool_use_id)) ? m.tool_use_id : undefined;
                    const actor = typeof m.subagent_type === 'string' ? m.subagent_type : undefined;
                    const agent: TrackedAgent = { agentId, ...(toolUseId !== undefined ? { callId: toolUseId } : {}), kind, ...(actor !== undefined ? { actor } : {}), background: m.is_backgrounded === true, terminal: false };
                    agents.set(agentId, agent);
                    if (toolUseId !== undefined) byCall.set(toolUseId, agentId);
                    const description = typeof m.description === 'string' ? m.description : undefined;
                    const title = kind === 'workflow' ? (typeof m.workflow_name === 'string' ? m.workflow_name : description) : description;
                    emit({
                        type: 'agent-start',
                        agentId,
                        ...(toolUseId !== undefined ? { callId: toolUseId } : {}),
                        kind,
                        ...(title !== undefined ? { title } : {}),
                        ...(typeof m.prompt === 'string' ? { description: m.prompt } : {}),
                        ...(typeof m.spawn_depth === 'number' ? { depth: m.spawn_depth } : {}),
                        background: agent.background,
                        ...context(agent)
                    });
                    update(agent, 'running', {}, emit);
                    return true;
                }
                case 'task_progress': {
                    const agent = agents.get(agentId);
                    if (!agent) return false;
                    const summary = typeof m.summary === 'string' ? m.summary : typeof m.last_tool_name === 'string' ? m.last_tool_name : undefined;
                    const usage = totals(m.usage);
                    update(agent, 'running', { ...(summary !== undefined ? { summary } : {}), ...(usage ? { usage } : {}) }, emit);
                    return true;
                }
                case 'task_updated': {
                    const agent = agents.get(agentId);
                    const patch = m.patch as Record<string, unknown> | undefined;
                    const status = typeof patch?.status === 'string' ? patch.status : undefined;
                    if (!agent || status === undefined) return false;
                    if (status === 'pending') return true;
                    if (patch?.is_backgrounded === true) agent.background = true;
                    if (status === 'running' || status === 'paused') update(agent, status, {}, emit);
                    else if (status === 'failed') end(agent, 'failed', { error: { code: 'provider_error', message: typeof patch?.error === 'string' ? patch.error : 'The sub-agent failed.' } }, emit);
                    else if (TERMINAL[status]) end(agent, TERMINAL[status]!, {}, emit);
                    return true;
                }
                case 'task_notification': {
                    const agent = agents.get(agentId);
                    if (!agent) return false;
                    const status = typeof m.status === 'string' ? TERMINAL[m.status] : undefined;
                    const summary = typeof m.summary === 'string' ? m.summary : undefined;
                    const usage = totals(m.usage);
                    const extra = { ...(summary !== undefined ? { summary } : {}), ...(usage ? { usage } : {}) };
                    if (status === 'failed') end(agent, 'failed', { ...extra, error: { code: 'provider_error', message: summary ?? 'The sub-agent failed.' } }, emit);
                    else end(agent, status ?? 'completed', extra, emit);
                    return true;
                }
                default:
                    return false;
            }
        },
        settleCall(callId, toolUseResult, text, isError, emit) {
            const agentId = byCall.get(callId);
            const agent = agentId !== undefined ? agents.get(agentId) : undefined;
            if (!agent) return;
            const r = (typeof toolUseResult === 'object' && toolUseResult !== null ? toolUseResult : {}) as Record<string, unknown>;
            if (r.status === 'async_launched' || r.status === 'remote_launched') {
                // The call settled but the agent runs on — a notification ends it later.
                agent.background = true;
                return;
            }
            if (r.status === 'completed') {
                const content = Array.isArray(r.content) ? (r.content as { type?: string; text?: unknown }[]).filter((c) => c.type === 'text').map((c) => String(c.text)).join('\n') : '';
                const usage = { ...toUsage(r.usage as Record<string, unknown> | undefined), ...(typeof r.totalTokens === 'number' ? { totalTokens: r.totalTokens } : {}) };
                end(agent, 'completed', { output: content || text, ...(Object.keys(usage).length ? { usage } : {}) }, emit);
                return;
            }
            if (isError) end(agent, 'failed', { error: { code: 'provider_error', message: text } }, emit);
            else end(agent, 'completed', { output: text }, emit);
        },
        actorFor(callId) {
            if (!callId) return undefined;
            const agentId = byCall.get(callId);
            return agentId !== undefined ? agents.get(agentId)?.actor : undefined;
        },
        get: (agentId) => agents.get(agentId),
        sweep(status, emit, options = {}) {
            for (const agent of agents.values()) {
                if (agent.terminal) continue;
                if (agent.background && options.background === false) continue;
                end(agent, status, status === 'failed' ? { error: { code: 'provider_error', message: options.message ?? 'The sub-agent ended without a result.' } } : {}, emit);
            }
        }
    };
}

/** An Anthropic `usage` object → ours (shared with the result mapping). */
export function toUsage(u: Record<string, unknown> | undefined): Usage | undefined {
    if (!u) return undefined;
    const out: Usage = {};
    const num = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : undefined);
    const map: Record<string, string> = { input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_input_tokens: 'cacheReadInputTokens', cache_creation_input_tokens: 'cacheCreationInputTokens' };
    for (const [from, to] of Object.entries(map)) {
        const v = num(from);
        if (v !== undefined) out[to] = v;
    }
    // The billed thinking tokens — a BREAKDOWN of `output_tokens`, not an
    // addition to them, and the same key the Anthropic provider reports.
    const thinking = (u.output_tokens_details as { thinking_tokens?: unknown } | undefined)?.thinking_tokens;
    if (typeof thinking === 'number') out.reasoningTokens = thinking;
    return Object.keys(out).length ? out : undefined;
}
