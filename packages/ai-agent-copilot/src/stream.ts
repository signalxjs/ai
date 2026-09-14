/**
 * Copilot session events → agent events, for one turn. Message and
 * reasoning deltas become parts (opened on the first delta, closed by the
 * complete event that follows), tool executions become `tool-call` /
 * `tool-update` with `coding.terminal` for shell output, `assistant.usage`
 * is summed into turn and session usage, sub-agents become `agent-start` /
 * `agent-update` with their own events nested under the spawning call, and
 * anything we do not model is passed through as `ext { ns: 'copilot' }`.
 *
 * The turn ends at `session.idle` (cancelled when we asked for it), or
 * shortly after a `session.error` the runtime never follows with idle.
 */

import type { SessionEvent } from '@github/copilot-sdk';
import type { Usage } from '@sigx/ai';
import type { AgentErrorCode, AgentStatus, ErrorInfo, StopReason, ToolStatus, UnstampedEvent } from '@sigx/ai-agent';
import { categoryOf, codingEvent } from '@sigx/ai-agent/coding';
import { COPILOT_NS } from './options.js';
import { toErrorCode, toToolStatus } from './request.js';

export interface TurnOutcome {
    readonly stopReason: StopReason;
    readonly error?: ErrorInfo;
    readonly usage?: Usage;
}

export interface TurnMapper {
    /** Feed a session event that arrived while this turn runs. */
    handle(event: SessionEvent): void;
    /** Resolves at `session.idle`. */
    readonly outcome: Promise<TurnOutcome>;
    /** Announce a tool call (idempotent) — the tool handler does, in case the runtime's own start event is late or missing. */
    announce(callId: string, name: string, input: unknown): void;
    /** Move a call's status from outside the event stream (the tool handler, a denial). A settled call ignores later events. */
    status(callId: string, status: ToolStatus, detail?: { readonly output?: unknown; readonly error?: string }): void;
    /** The permission handler denied this call: its completion reads `denied`. */
    markDenied(callId: string, message: string): void;
}

/** What the session knows about one sub-agent: the call that spawned it and where it stands. */
export interface SubAgent {
    readonly callId: string;
    readonly title: string;
    /** The runtime's own id for it, once one of its events named it. */
    sdkId?: string;
    status: AgentStatus;
}

/** Sub-agents by our agent id (the spawning call's id), for the life of the session. */
export type SubAgents = Map<string, SubAgent>;

export const AGENT_TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['completed', 'failed', 'cancelled']);

/** Every sub-agent still running gets `status` — a cancelled turn, or the session closing under it. */
export function settleSubAgents(agents: SubAgents, status: 'cancelled' | 'failed', emit: (e: UnstampedEvent) => void): void {
    for (const [agentId, agent] of agents) {
        if (AGENT_TERMINAL.has(agent.status)) continue;
        agent.status = status;
        emit({ type: 'agent-update', agentId, status, parentCallId: agent.callId });
    }
}

/** Cumulative usage for the session, kept by the session and fed to every turn's mapper. */
export interface SessionUsage {
    usage: Usage;
}

export function emptyUsage(): Usage {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/** One `assistant.usage` under the well-known `Usage` keys every adapter shares. */
export function toUsage(u: Extract<SessionEvent, { type: 'assistant.usage' }>['data']): Usage {
    const input = u.inputTokens ?? 0;
    const output = u.outputTokens ?? 0;
    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        ...(u.cacheReadTokens !== undefined ? { cacheReadInputTokens: u.cacheReadTokens } : {}),
        ...(u.cacheWriteTokens !== undefined ? { cacheCreationInputTokens: u.cacheWriteTokens } : {}),
        ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {})
    };
}

export function addUsage(into: Usage, more: Usage): Usage {
    const out: Usage = { ...into };
    for (const [k, v] of Object.entries(more)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
    return out;
}

export interface TurnMapperOptions {
    /** The message id of the first assistant message; later ones count up from it (`a:<turn>:0`, `a:<turn>:1`, …). */
    readonly messageId: string;
    readonly agents: SubAgents;
    readonly usage: SessionUsage;
    /** A `session.error` not followed by `session.idle` within this many ms ends the turn. */
    readonly errorSettleMs: number;
    /** Whether the client asked to cancel: `session.idle` then means `cancelled`. */
    readonly cancelled: () => boolean;
}

/** Where a mapper publishes: the turn driver. */
export interface EventSink {
    emit(event: UnstampedEvent): unknown;
}

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'shell', 'powershell', 'run_in_terminal', 'execute', 'exec']);

/**
 * Runtime chatter that is not the transcript's business — per-chunk byte
 * counts, the model layer's own telemetry (`model.*`, one event per call and
 * per tool), queue bookkeeping, the external-tool plumbing our handler already
 * covers, the sandbox's enforcement notes and the full system prompt. Seen
 * live against Copilot CLI 1.0.83; everything else unknown is `ext`.
 */
export function isChatter(type: string): boolean {
    return (
        type === 'assistant.streaming_delta' ||
        type === 'assistant.tool_call_delta' ||
        type === 'session.background_tasks_changed' ||
        type === 'system.message' ||
        type.startsWith('model.') ||
        type.startsWith('pending_messages.') ||
        type.startsWith('external_tool.') ||
        type.startsWith('sandbox.')
    );
}

export function createTurnMapper(driver: EventSink, options: TurnMapperOptions): TurnMapper {
    const { agents } = options;
    const base = options.messageId.replace(/:\d+$/, '');
    let messages = Number(options.messageId.slice(base.length + 1)) || 0;
    /** Copilot message id → our message id. */
    const messageIds = new Map<string, string>();
    /** Open text/reasoning parts by part id, with how much of them has been streamed. */
    const parts = new Map<string, { kind: 'text' | 'reasoning'; streamed: number }>();
    /** Calls announced, and the ones whose status is settled (a later completion event is then noise). */
    const calls = new Map<string, { name: string; settled: boolean; started: boolean; parentCallId?: string }>();
    const denied = new Map<string, string>();
    const terminals = new Set<string>();
    let turnUsage: Usage | undefined;
    let error: ErrorInfo | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let resolveOutcome!: (o: TurnOutcome) => void;
    const outcome = new Promise<TurnOutcome>((resolve) => {
        resolveOutcome = resolve;
    });

    const emit = (e: UnstampedEvent) => driver.emit(e);

    /** Where an event sits: under a sub-agent's spawn call (spoken by the agent), under a parent call, or at the top. */
    const nestingOf = (event: { agentId?: string; data: unknown }): { parentCallId?: string; actor?: string } => {
        const agent = event.agentId !== undefined ? bindAgent(event.agentId) : undefined;
        if (agent) return { parentCallId: agent.callId, actor: agent.title };
        const parent = (event.data as { parentToolCallId?: string } | undefined)?.parentToolCallId;
        return parent !== undefined ? { parentCallId: parent } : {};
    };
    /** The sub-agent an SDK agent id belongs to: the one already bound to it, else the oldest running one not yet named. */
    const bindAgent = (sdkId: string): SubAgent | undefined => {
        for (const a of agents.values()) if (a.sdkId === sdkId) return a;
        for (const a of agents.values()) {
            if (a.sdkId === undefined && !AGENT_TERMINAL.has(a.status)) {
                a.sdkId = sdkId;
                return a;
            }
        }
        return undefined;
    };

    /** Messages per scope: the host's count up from the turn's first id; a sub-agent's count under its spawning call. */
    const scopes = new Map<string, number>();
    const scopeOf = (nesting: { parentCallId?: string }) => (nesting.parentCallId !== undefined ? `a:${nesting.parentCallId}` : base);
    const ourMessageId = (copilotId: string, nesting: { parentCallId?: string }): string => {
        let id = messageIds.get(copilotId);
        if (!id) {
            const scope = scopeOf(nesting);
            const n = scope === base ? messages++ : (scopes.get(scope) ?? 0);
            if (scope !== base) scopes.set(scope, n + 1);
            id = `${scope}:${n}`;
            messageIds.set(copilotId, id);
        }
        return id;
    };
    /** The message a call or reasoning part belongs to: the latest one in its scope. */
    const currentMessageId = (nesting: { parentCallId?: string }): string => {
        const scope = scopeOf(nesting);
        const n = scope === base ? messages : (scopes.get(scope) ?? 0);
        return `${scope}:${Math.max(0, n - 1)}`;
    };
    const openPart = (partId: string, kind: 'text' | 'reasoning', messageId: string, nesting: { parentCallId?: string; actor?: string }) => {
        if (parts.has(partId)) return;
        parts.set(partId, { kind, streamed: 0 });
        emit({ type: 'part-start', messageId, partId, kind, ...(nesting.actor !== undefined ? { actor: nesting.actor } : {}), ...(nesting.parentCallId !== undefined ? { parentCallId: nesting.parentCallId } : {}) });
    };
    const delta = (partId: string, kind: 'text' | 'reasoning', messageId: string, text: string, nesting: { parentCallId?: string; actor?: string }) => {
        openPart(partId, kind, messageId, nesting);
        const p = parts.get(partId)!;
        p.streamed += text.length;
        emit({ type: 'part-delta', partId, delta: text, ...(nesting.parentCallId !== undefined ? { parentCallId: nesting.parentCallId } : {}) });
    };
    /** Close a part, first delivering whatever of `full` was never streamed. */
    const closePart = (partId: string, kind: 'text' | 'reasoning', messageId: string, full: string, nesting: { parentCallId?: string; actor?: string }) => {
        openPart(partId, kind, messageId, nesting);
        const p = parts.get(partId)!;
        if (full.length > p.streamed) emit({ type: 'part-delta', partId, delta: full.slice(p.streamed), ...(nesting.parentCallId !== undefined ? { parentCallId: nesting.parentCallId } : {}) });
        parts.delete(partId);
        emit({ type: 'part-end', partId, ...(nesting.parentCallId !== undefined ? { parentCallId: nesting.parentCallId } : {}) });
    };
    const partNesting = new Map<string, { parentCallId?: string; actor?: string }>();

    const announce = (callId: string, name: string, input: unknown, nesting: { parentCallId?: string } = {}) => {
        if (calls.has(callId)) return;
        calls.set(callId, { name, settled: false, started: false, ...(nesting.parentCallId !== undefined ? { parentCallId: nesting.parentCallId } : {}) });
        const category = categoryOf(name);
        if (category === 'execute' || SHELL_TOOLS.has(name.toLowerCase())) terminals.add(callId);
        const parent = nesting.parentCallId !== undefined ? { parentCallId: nesting.parentCallId } : {};
        emit({ type: 'tool-call', callId, name, messageId: currentMessageId(nesting), input, ...(category !== undefined ? { category } : {}), ...parent });
        emit({ type: 'tool-update', callId, status: 'pending', ...parent });
    };
    const status = (callId: string, s: ToolStatus, detail?: { readonly output?: unknown; readonly error?: string }) => {
        const call = calls.get(callId);
        if (!call || call.settled) return;
        if (s === 'in_progress') {
            if (call.started) return;
            call.started = true;
        } else call.settled = true;
        emit({
            type: 'tool-update',
            callId,
            status: s,
            ...(detail?.output !== undefined ? { output: detail.output } : {}),
            ...(detail?.error !== undefined ? { error: detail.error } : {}),
            ...(call.parentCallId !== undefined ? { parentCallId: call.parentCallId } : {})
        });
    };

    const startAgent = (callId: string, init: { title: string; description?: string; model?: string }) => {
        if (agents.has(callId)) return;
        agents.set(callId, { callId, title: init.title, status: 'running' });
        emit({ type: 'agent-start', agentId: callId, callId, kind: 'subagent', title: init.title, ...(init.description !== undefined ? { description: init.description } : {}), ...(init.model !== undefined ? { model: init.model } : {}), parentCallId: callId });
        emit({ type: 'agent-update', agentId: callId, status: 'running', parentCallId: callId });
    };
    const updateAgent = (callId: string, next: { status: AgentStatus; error?: string; usage?: Usage }) => {
        const agent = agents.get(callId);
        if (!agent || AGENT_TERMINAL.has(agent.status)) return;
        agent.status = next.status;
        emit({
            type: 'agent-update',
            agentId: callId,
            status: next.status,
            ...(next.error !== undefined ? { error: { code: 'provider_error' as AgentErrorCode, message: next.error } } : {}),
            ...(next.usage !== undefined ? { usage: next.usage } : {}),
            parentCallId: callId
        });
    };

    const finish = () => {
        if (done) return;
        done = true;
        if (settleTimer) clearTimeout(settleTimer);
        for (const [partId, part] of Array.from(parts)) closePart(partId, part.kind, currentMessageId(partNesting.get(partId) ?? {}), '', partNesting.get(partId) ?? {});
        const cancelled = options.cancelled();
        if (cancelled) settleSubAgents(agents, 'cancelled', emit);
        const stopReason: StopReason = cancelled ? 'cancelled' : error ? 'error' : 'end_turn';
        resolveOutcome({ stopReason, ...(error && !cancelled ? { error } : {}), ...(turnUsage ? { usage: turnUsage } : {}) });
    };

    return {
        outcome,
        announce: (callId, name, input) => announce(callId, name, input),
        status,
        markDenied(callId, message) {
            denied.set(callId, message);
            status(callId, 'denied', { error: message });
        },
        handle(event) {
            if (done) return;
            if (settleTimer) {
                clearTimeout(settleTimer);
                settleTimer = undefined;
            }
            const nesting = nestingOf(event);
            switch (event.type) {
                case 'assistant.message_delta': {
                    const partId = event.data.messageId;
                    partNesting.set(partId, nesting);
                    delta(partId, 'text', ourMessageId(event.data.messageId, nesting), event.data.deltaContent, nesting);
                    break;
                }
                case 'assistant.message': {
                    const partId = event.data.messageId;
                    const n = partNesting.get(partId) ?? nesting;
                    // A message that only carries tool requests has no text to show.
                    if (event.data.content || parts.has(partId)) closePart(partId, 'text', ourMessageId(event.data.messageId, n), event.data.content, n);
                    partNesting.delete(partId);
                    break;
                }
                case 'assistant.reasoning_delta': {
                    const partId = `r:${event.data.reasoningId}`;
                    partNesting.set(partId, nesting);
                    delta(partId, 'reasoning', currentMessageId(nesting), event.data.deltaContent, nesting);
                    break;
                }
                case 'assistant.reasoning': {
                    const partId = `r:${event.data.reasoningId}`;
                    const n = partNesting.get(partId) ?? nesting;
                    closePart(partId, 'reasoning', currentMessageId(n), event.data.content, n);
                    partNesting.delete(partId);
                    break;
                }
                case 'tool.execution_start': {
                    const d = event.data;
                    const name = d.mcpServerName !== undefined && d.mcpToolName !== undefined ? `${d.mcpServerName}/${d.mcpToolName}` : d.toolName;
                    announce(d.toolCallId, name, d.arguments ?? {}, nesting);
                    status(d.toolCallId, 'in_progress');
                    break;
                }
                case 'tool.execution_progress':
                    status(event.data.toolCallId, 'in_progress');
                    break;
                case 'tool.execution_partial_result': {
                    const d = event.data;
                    if (terminals.has(d.toolCallId)) emit(codingEvent('terminal', { terminalId: d.toolCallId, stream: 'stdout', delta: d.partialOutput }, { parentCallId: d.toolCallId }));
                    else if (calls.has(d.toolCallId)) emit({ type: 'ext', ns: COPILOT_NS, name: event.type, data: d, parentCallId: d.toolCallId });
                    break;
                }
                case 'tool.execution_complete': {
                    const d = event.data;
                    const s = toToolStatus(d, denied.has(d.toolCallId));
                    const text = d.result?.content ?? '';
                    if (terminals.has(d.toolCallId)) emit(codingEvent('terminal-exit', { terminalId: d.toolCallId, exitCode: d.success ? 0 : null }, { parentCallId: d.toolCallId }));
                    if (s === 'completed') status(d.toolCallId, s, { output: d.result?.structuredContent ?? text });
                    else status(d.toolCallId, s, { error: denied.get(d.toolCallId) ?? d.error?.message ?? (text || 'The tool call failed.') });
                    break;
                }
                case 'assistant.usage': {
                    // A sub-agent's tokens are its own; they show on the agent, not the host's totals.
                    // `cost` is NOT money — it is the model's premium-request multiplier (27 per
                    // Opus call, live) — so nothing here becomes `costUsd`.
                    const u = toUsage(event.data);
                    if (nesting.actor !== undefined) {
                        const agent = event.agentId !== undefined ? bindAgent(event.agentId) : undefined;
                        if (agent) emit({ type: 'agent-update', agentId: agent.callId, status: agent.status, usage: u, parentCallId: agent.callId });
                        break;
                    }
                    turnUsage = addUsage(turnUsage ?? emptyUsage(), u);
                    options.usage.usage = addUsage(options.usage.usage, u);
                    emit({ type: 'usage', scope: 'turn', usage: turnUsage });
                    emit({ type: 'usage', scope: 'session', usage: options.usage.usage });
                    break;
                }
                case 'subagent.started': {
                    const d = event.data;
                    announce(d.toolCallId, 'task', { agent: d.agentName, description: d.agentDescription });
                    status(d.toolCallId, 'in_progress');
                    startAgent(d.toolCallId, { title: d.agentDisplayName || d.agentName, description: d.agentDescription, ...(d.model !== undefined ? { model: d.model } : {}) });
                    break;
                }
                case 'subagent.completed': {
                    // The sub-agent ends with its spawning call: the runtime's own completion for that call, if any, comes after.
                    const d = event.data;
                    updateAgent(d.toolCallId, { status: d.cancelled ? 'cancelled' : 'completed', ...(d.totalTokens !== undefined ? { usage: { totalTokens: d.totalTokens } } : {}) });
                    status(d.toolCallId, d.cancelled ? 'cancelled' : 'completed');
                    break;
                }
                case 'subagent.failed':
                    updateAgent(event.data.toolCallId, { status: 'failed', error: event.data.error });
                    status(event.data.toolCallId, 'failed', { error: event.data.error });
                    break;
                case 'session.error': {
                    const d = event.data;
                    // A sub-agent's error would read as the host's own.
                    if (nesting.actor !== undefined) break;
                    error = { code: toErrorCode(d), message: d.message };
                    emit({ type: 'error', code: error.code, message: d.message, recoverable: false });
                    settleTimer = setTimeout(finish, options.errorSettleMs);
                    break;
                }
                case 'session.idle':
                    finish();
                    break;
                case 'user.message':
                case 'assistant.turn_start':
                case 'assistant.turn_end':
                case 'assistant.message_start':
                case 'assistant.idle':
                case 'abort':
                case 'permission.requested':
                case 'permission.completed':
                case 'user_input.requested':
                case 'user_input.completed':
                case 'session.start':
                case 'session.resume':
                case 'session.model_change':
                    break;
                default:
                    if (isChatter(event.type)) break;
                    emit({ type: 'ext', ns: COPILOT_NS, name: event.type, data: event.data ?? null, ...(nesting.parentCallId !== undefined ? { parentCallId: nesting.parentCallId } : {}) });
            }
        }
    };
}
