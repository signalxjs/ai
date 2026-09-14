/**
 * Codex notifications → agent events, for one turn. A state machine over
 * items: agent messages and reasoning become parts (opened on `item/started`
 * or the first delta, closed on `item/completed`), command executions, file
 * changes and tool calls become `tool-call` / `tool-update` with the coding
 * extension events alongside, plans become `coding.plan`, and anything we do
 * not model is passed through as `ext { ns: 'codex' }`.
 *
 * Sub-agents: Codex runs a sub-agent as a thread of its own and reports it
 * on the parent thread through `collabAgentToolCall` items (the spawn and
 * every later instruction to it, each carrying the last known state of the
 * agents it addressed) and `subAgentActivity` items. A spawn is a call
 * (`collab/spawnAgent`) and the spawned thread an `agent-start` bound to it;
 * state changes become `agent-update`s, once per change and one terminal
 * each. The registry lives with the session, not the turn: a sub-agent can
 * outlive the turn that spawned it. Codex 0.154 reports the spawn itself as a
 * `subAgentActivity` "started" item whose id is the model's tool call, and
 * streams the child thread's own turns on the same connection; the session
 * maps those through a nested mapper (see `nested`).
 */

import type { Usage } from '@sigx/ai';
import type { AgentErrorCode, AgentStatus, StopReason, ToolStatus, UnstampedEvent } from '@sigx/ai-agent';
import { codingEvent } from '@sigx/ai-agent/coding';
import { CODEX_METHODS } from './schema.js';
import type {
    CodexErrorInfo,
    CollabAgentState,
    CollabAgentToolCallStatus,
    ErrorNotification,
    FileChangePatchUpdatedNotification,
    FileUpdateChange,
    ItemDeltaNotification,
    ItemNotification,
    KnownThreadItem,
    ThreadTokenUsageUpdatedNotification,
    TokenUsageBreakdown,
    TurnCompletedNotification,
    TurnDiffUpdatedNotification,
    TurnPlanUpdatedNotification,
    TurnStatus
} from './schema.js';

export const CODEX_NS = 'codex';

export interface TurnOutcome {
    readonly stopReason: StopReason;
    readonly error?: { readonly code: AgentErrorCode; readonly message: string };
    /** The final agent message, for structured output. */
    readonly finalText: string;
    readonly usage?: Usage;
}

export interface TurnMapper {
    /** Feed a notification that belongs to this turn (or to the thread while this turn runs). */
    notify(method: string, params: unknown): void;
    /** Resolves on `turn/completed`. */
    readonly outcome: Promise<TurnOutcome>;
    /** Mark a tool call's status from a request handler (approval flow). */
    toolStatus(callId: string, status: ToolStatus, error?: string): void;
}

/** What the session knows about one sub-agent thread: the call that spawned it and where it stands. */
export interface SubAgent {
    readonly callId?: string;
    /** Codex's name for it (the agent path), when reported. */
    readonly title?: string;
    status: AgentStatus;
    summary?: string;
}

/** Sub-agents by thread id, for the life of the session. */
export type SubAgents = Map<string, SubAgent>;

export const AGENT_TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['completed', 'failed', 'cancelled']);

/** Every sub-agent still running gets `status` — an interrupted turn, or the session closing under it. */
export function settleSubAgents(agents: SubAgents, status: 'cancelled' | 'failed', emit: (e: UnstampedEvent) => void): void {
    for (const [agentId, agent] of agents) {
        if (AGENT_TERMINAL.has(agent.status)) continue;
        agent.status = status;
        emit({ type: 'agent-update', agentId, status, ...(agent.callId !== undefined ? { parentCallId: agent.callId } : {}) });
    }
}

export interface SubAgentChange {
    readonly status: AgentStatus;
    readonly summary?: string;
    readonly output?: unknown;
    readonly error?: string;
    /** The sub-agent's own cumulative usage; a usage report always goes out, even when nothing else changed. */
    readonly usage?: Usage;
}

/** A state change for a known sub-agent — nothing after its terminal, nothing for a repeat. */
export function updateSubAgent(agents: SubAgents, emit: (e: UnstampedEvent) => void, agentId: string, next: SubAgentChange): void {
    const agent = agents.get(agentId);
    if (!agent || AGENT_TERMINAL.has(agent.status)) return;
    if (next.usage === undefined && next.status === agent.status && next.summary === agent.summary) return;
    agent.status = next.status;
    agent.summary = next.summary;
    emit({
        type: 'agent-update',
        agentId,
        status: next.status,
        ...(next.summary !== undefined ? { summary: next.summary } : {}),
        ...(next.output !== undefined ? { output: next.output } : {}),
        ...(next.error !== undefined ? { error: { code: 'provider_error', message: next.error } } : {}),
        ...(next.usage !== undefined ? { usage: next.usage } : {}),
        ...(agent.callId !== undefined ? { parentCallId: agent.callId } : {})
    });
}

function collabCallStatus(status: CollabAgentToolCallStatus): ToolStatus {
    switch (status) {
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        case 'interrupted':
            return 'cancelled';
        default:
            return 'in_progress';
    }
}

/** A Codex agent state onto the contract's lifecycle, with what to say about it. */
function agentTransition(state: CollabAgentState): { readonly status: AgentStatus; readonly output?: string; readonly error?: string } {
    switch (state.status) {
        case 'completed':
            return { status: 'completed', ...(state.message !== null ? { output: state.message } : {}) };
        case 'errored':
            return { status: 'failed', error: state.message ?? 'The sub-agent failed.' };
        case 'notFound':
            return { status: 'failed', error: state.message ?? 'Codex has no such agent.' };
        case 'interrupted':
        case 'shutdown':
            return { status: 'cancelled' };
        default:
            return { status: 'running' };
    }
}

export function toUsage(u: TokenUsageBreakdown): Usage {
    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens,
        // The well-known `Usage` keys, not Codex's own spellings: every
        // adapter reports the cache and reasoning breakdowns under the same
        // names, so a client reads them without knowing the harness (see
        // `Usage` in `@sigx/ai`).
        cacheReadInputTokens: u.cachedInputTokens,
        cacheCreationInputTokens: u.cacheWriteInputTokens,
        reasoningTokens: u.reasoningOutputTokens
    };
}

export function toErrorCode(info: CodexErrorInfo | null | undefined): AgentErrorCode {
    const name = typeof info === 'string' ? info : info ? Object.keys(info)[0] : undefined;
    switch (name) {
        case 'contextWindowExceeded':
            return 'context_exceeded';
        case 'rateLimitExceeded':
        case 'usageLimitExceeded':
        case 'sessionBudgetExceeded':
        case 'serverOverloaded':
            return 'rate_limited';
        case 'unauthorized':
            return 'auth_required';
        default:
            return 'provider_error';
    }
}

export function toStopReason(status: TurnStatus): StopReason {
    switch (status) {
        case 'completed':
            return 'end_turn';
        case 'interrupted':
            return 'cancelled';
        case 'failed':
            return 'error';
        default:
            return 'end_turn';
    }
}

function itemStatus(status: string | undefined, success?: boolean | null): ToolStatus {
    switch (status) {
        case 'completed':
            return success === false ? 'failed' : 'completed';
        case 'failed':
            return 'failed';
        case 'declined':
            return 'denied';
        default:
            return 'in_progress';
    }
}

export interface TurnMapperOptions {
    readonly messageId: string;
    /** The session's sub-agent registry (a sub-agent can outlive the turn). */
    readonly agents?: SubAgents;
    /** A sub-agent thread seen for the first time, so the session can route that thread's frames to itself. */
    readonly onAgent?: (agentId: string) => void;
    /**
     * Set when this mapper reads a sub-agent's own thread: its parts speak as
     * `actor`, and its usage and errors stay off the host's totals and state
     * (the session reports usage on the agent; its outcome is the agent's status).
     */
    readonly nested?: { readonly actor?: string };
}

/** Where a mapper publishes: a turn driver, or a sub-agent's emitter that nests and routes its events. */
export interface EventSink {
    emit(event: UnstampedEvent): unknown;
}

export function createTurnMapper(driver: EventSink, options: TurnMapperOptions): TurnMapper {
    const { messageId, nested } = options;
    const actor = nested?.actor;
    const agents: SubAgents = options.agents ?? new Map();
    /** Spawn calls reported as a `subAgentActivity` "started" item, and which of them completed. */
    const activitySpawns = new Set<string>();
    const settledSpawns = new Set<string>();
    /** Open text/reasoning parts by part id, with how much of them has been streamed. */
    const parts = new Map<string, { kind: 'text' | 'reasoning'; streamed: number }>();
    /** Item ids of tool calls announced, so updates for unknown items are ignored. */
    const calls = new Set<string>();
    /** Calls the policy denied — Codex still reports them `failed`, which must not follow `denied`. */
    const denied = new Set<string>();
    const diffsEmitted = new Set<string>();
    /** Spawn calls that already bound their one agent. */
    const spawned = new Set<string>();
    let finalText = '';
    let turnUsage: Usage | undefined;
    let resolveOutcome!: (o: TurnOutcome) => void;
    const outcome = new Promise<TurnOutcome>((resolve) => {
        resolveOutcome = resolve;
    });

    const emit = (e: UnstampedEvent) => driver.emit(e);

    const openPart = (partId: string, kind: 'text' | 'reasoning') => {
        if (parts.has(partId)) return;
        parts.set(partId, { kind, streamed: 0 });
        emit({ type: 'part-start', messageId, partId, kind, ...(actor !== undefined ? { actor } : {}) });
    };
    const delta = (partId: string, kind: 'text' | 'reasoning', text: string) => {
        openPart(partId, kind);
        const p = parts.get(partId)!;
        p.streamed += text.length;
        emit({ type: 'part-delta', partId, delta: text });
    };
    /** Close a part, first delivering whatever of `full` was never streamed. */
    const closePart = (partId: string, kind: 'text' | 'reasoning', full: string) => {
        openPart(partId, kind);
        const p = parts.get(partId)!;
        if (full.length > p.streamed) emit({ type: 'part-delta', partId, delta: full.slice(p.streamed) });
        parts.delete(partId);
        emit({ type: 'part-end', partId });
    };

    const announceCall = (item: KnownThreadItem, name: string, category: string, input: unknown) => {
        if (calls.has(item.id)) return;
        calls.add(item.id);
        emit({ type: 'tool-call', callId: item.id, name, messageId, input, category });
        emit({ type: 'tool-update', callId: item.id, status: 'pending' });
    };

    /** First sight of a sub-agent thread: announce it (bound to its spawn call when we saw one) as running. */
    const startAgent = (agentId: string, init: { readonly callId?: string; readonly title?: string; readonly description?: string; readonly model?: string; readonly summary?: string }) => {
        if (agents.has(agentId)) return;
        agents.set(agentId, {
            ...(init.callId !== undefined ? { callId: init.callId } : {}),
            ...(init.title !== undefined ? { title: init.title } : {}),
            status: 'running',
            ...(init.summary !== undefined ? { summary: init.summary } : {})
        });
        const parent = init.callId !== undefined ? { parentCallId: init.callId } : {};
        emit({
            type: 'agent-start',
            agentId,
            kind: 'subagent',
            ...(init.callId !== undefined ? { callId: init.callId } : {}),
            ...(init.title !== undefined ? { title: init.title } : {}),
            ...(init.description !== undefined ? { description: init.description } : {}),
            ...(init.model !== undefined ? { model: init.model } : {}),
            ...parent
        });
        emit({ type: 'agent-update', agentId, status: 'running', ...(init.summary !== undefined ? { summary: init.summary } : {}), ...parent });
        options.onAgent?.(agentId);
    };
    const updateAgent = (agentId: string, next: SubAgentChange) => updateSubAgent(agents, emit, agentId, next);

    const emitDiffs = (itemId: string, changes: readonly FileUpdateChange[]) => {
        for (const c of changes) {
            const key = `${itemId}:${c.path}:${c.diff.length}`;
            if (diffsEmitted.has(key)) continue;
            diffsEmitted.add(key);
            emit(codingEvent('diff', { path: c.path, unifiedDiff: c.diff }, { parentCallId: itemId }));
        }
    };

    const onItem = (n: ItemNotification, phase: 'started' | 'completed') => {
        // The union carries an open variant for items we do not model; the
        // switch narrows the known ones and the default passes the rest through.
        const item = n.item as KnownThreadItem;
        switch (item.type) {
            case 'userMessage':
                // Turns we start announce their own user-message; a replayed one would be an import.
                break;
            case 'agentMessage': {
                const partId = item.id;
                if (phase === 'started') openPart(partId, 'text');
                else {
                    closePart(partId, 'text', item.text);
                    finalText = item.text;
                }
                break;
            }
            case 'plan': {
                // A proposed plan the model writes out (`item/plan/delta` streams it); the
                // structured step list Codex tracks is `turn/plan/updated` → `coding.plan`.
                if (phase === 'started') openPart(item.id, 'text');
                else closePart(item.id, 'text', item.text);
                break;
            }
            case 'reasoning': {
                if (phase === 'completed') {
                    item.summary.forEach((text, i) => closePart(`${item.id}:s${i}`, 'reasoning', text));
                    item.content.forEach((text, i) => closePart(`${item.id}:c${i}`, 'reasoning', text));
                    // A reasoning item may have streamed parts of indexes the final arrays omit.
                    for (const partId of Array.from(parts.keys())) if (partId.startsWith(`${item.id}:`)) closePart(partId, 'reasoning', '');
                }
                break;
            }
            case 'commandExecution': {
                announceCall(item, 'shell', 'execute', { command: item.command, cwd: item.cwd });
                if (phase === 'completed') {
                    emit(codingEvent('terminal-exit', { terminalId: item.id, exitCode: item.exitCode }, { parentCallId: item.id }));
                    const status = itemStatus(item.status);
                    emit({
                        type: 'tool-update',
                        callId: item.id,
                        status,
                        ...(status === 'completed' && item.aggregatedOutput !== null ? { output: item.aggregatedOutput } : {}),
                        ...(status === 'failed' ? { error: item.aggregatedOutput ?? `exit code ${String(item.exitCode)}` } : {}),
                        ...(status === 'denied' ? { error: 'Declined.' } : {})
                    });
                } else if (item.status === 'inProgress') emit({ type: 'tool-update', callId: item.id, status: 'in_progress' });
                break;
            }
            case 'fileChange': {
                announceCall(item, 'apply_patch', 'edit', { changes: item.changes.map((c) => ({ path: c.path, kind: c.kind.type })) });
                if (phase === 'completed') {
                    emitDiffs(item.id, item.changes);
                    emit(codingEvent('files-changed', { paths: item.changes.map((c) => c.path) }, { parentCallId: item.id }));
                    const status = itemStatus(item.status);
                    emit({ type: 'tool-update', callId: item.id, status, ...(status === 'denied' ? { error: 'Declined.' } : {}), ...(status === 'failed' ? { error: 'The patch could not be applied.' } : {}) });
                } else if (item.status === 'inProgress') emit({ type: 'tool-update', callId: item.id, status: 'in_progress' });
                break;
            }
            case 'mcpToolCall': {
                announceCall(item, `${item.server}/${item.tool}`, 'other', item.arguments);
                if (phase === 'completed') {
                    const status = itemStatus(item.status);
                    if (status === 'completed') emit({ type: 'tool-update', callId: item.id, status, output: item.result?.structuredContent ?? item.result?.content ?? null });
                    else emit({ type: 'tool-update', callId: item.id, status, error: item.error?.message ?? 'The tool call failed.' });
                } else emit({ type: 'tool-update', callId: item.id, status: 'in_progress' });
                break;
            }
            case 'dynamicToolCall': {
                announceCall(item, item.tool, 'other', item.arguments);
                if (phase === 'completed') {
                    if (denied.has(item.id)) break;
                    const status = itemStatus(item.status, item.success);
                    const text = (item.contentItems ?? []).map((c) => (c.type === 'inputText' ? c.text : c.imageUrl)).join('\n');
                    if (status === 'completed') emit({ type: 'tool-update', callId: item.id, status, output: text });
                    else emit({ type: 'tool-update', callId: item.id, status, error: text || 'The tool call failed.' });
                }
                break;
            }
            case 'webSearch': {
                announceCall(item, 'web_search', 'fetch', item.query !== undefined ? { query: item.query } : {});
                if (phase === 'completed') emit({ type: 'tool-update', callId: item.id, status: 'completed' });
                break;
            }
            case 'collabAgentToolCall': {
                announceCall(item, `collab/${item.tool}`, 'other', { prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort, receiverThreadIds: [...item.receiverThreadIds] });
                // A spawn names its child in `receiverThreadIds`; any call may carry
                // the state of a thread we have not seen (a spawn before our resume).
                // A call binds at most one agent — a spawn starts one thread — so a
                // second thread on the same spawn is announced without the call.
                const spawn = item.tool === 'spawnAgent';
                const start = (agentId: string) => {
                    if (agents.has(agentId)) return;
                    const bind = spawn && !spawned.has(item.id);
                    if (bind) spawned.add(item.id);
                    startAgent(agentId, {
                        ...(bind ? { callId: item.id } : {}),
                        ...(spawn && item.prompt !== null ? { description: item.prompt } : {}),
                        ...(spawn && item.model !== null ? { model: item.model } : {})
                    });
                };
                for (const agentId of item.receiverThreadIds) if (spawn) start(agentId);
                for (const [agentId, state] of Object.entries(item.agentsStates)) {
                    if (!state) continue;
                    start(agentId);
                    updateAgent(agentId, agentTransition(state));
                }
                if (phase === 'completed') {
                    const status = collabCallStatus(item.status);
                    emit({ type: 'tool-update', callId: item.id, status, ...(status === 'failed' ? { error: 'The collab call failed.' } : {}) });
                } else if (item.status === 'inProgress') emit({ type: 'tool-update', callId: item.id, status: 'in_progress' });
                break;
            }
            case 'subAgentActivity': {
                const running = item.kind === 'started' || item.kind === 'interacted';
                if (item.kind === 'started' && (activitySpawns.has(item.id) || !agents.has(item.agentThreadId))) {
                    // Codex 0.154 reports the spawn as the "started" activity, under the model's
                    // tool call id: that call spawns the thread (a collab spawnAgent that already
                    // named the thread keeps it).
                    activitySpawns.add(item.id);
                    announceCall(item, 'collab/spawnAgent', 'other', { agentPath: item.agentPath });
                    startAgent(item.agentThreadId, { callId: item.id, title: item.agentPath, summary: item.kind });
                    if (phase === 'completed' && !settledSpawns.has(item.id)) {
                        settledSpawns.add(item.id);
                        emit({ type: 'tool-update', callId: item.id, status: 'completed' });
                    }
                } else {
                    // Activity of a thread nobody spawned in our sight is still an agent — without a spawning call.
                    startAgent(item.agentThreadId, { title: item.agentPath, ...(running ? { summary: item.kind } : {}) });
                }
                switch (item.kind) {
                    case 'interrupted':
                        updateAgent(item.agentThreadId, { status: 'cancelled' });
                        break;
                    case 'completed':
                        updateAgent(item.agentThreadId, { status: 'completed' });
                        break;
                    default:
                        updateAgent(item.agentThreadId, { status: 'running', summary: item.kind });
                }
                break;
            }
            default:
                emit({ type: 'ext', ns: CODEX_NS, name: `item.${n.item.type}`, data: { phase, item: n.item } });
        }
    };

    return {
        outcome,
        toolStatus(callId, status, error) {
            if (!calls.has(callId)) return;
            if (status === 'denied') denied.add(callId);
            emit({ type: 'tool-update', callId, status, ...(error !== undefined ? { error } : {}) });
        },
        notify(method, params) {
            switch (method) {
                case CODEX_METHODS.itemStarted:
                    onItem(params as ItemNotification, 'started');
                    break;
                case CODEX_METHODS.itemCompleted:
                    onItem(params as ItemNotification, 'completed');
                    break;
                case CODEX_METHODS.agentMessageDelta:
                case CODEX_METHODS.planDelta: {
                    const p = params as ItemDeltaNotification;
                    delta(p.itemId, 'text', p.delta);
                    break;
                }
                case CODEX_METHODS.reasoningTextDelta: {
                    const p = params as ItemDeltaNotification;
                    delta(`${p.itemId}:c${p.contentIndex ?? 0}`, 'reasoning', p.delta);
                    break;
                }
                case CODEX_METHODS.reasoningSummaryDelta: {
                    const p = params as ItemDeltaNotification;
                    delta(`${p.itemId}:s${p.summaryIndex ?? 0}`, 'reasoning', p.delta);
                    break;
                }
                case CODEX_METHODS.commandOutputDelta:
                case CODEX_METHODS.fileChangeOutputDelta: {
                    const p = params as ItemDeltaNotification;
                    if (calls.has(p.itemId)) emit(codingEvent('terminal', { terminalId: p.itemId, stream: 'stdout', delta: p.delta }, { parentCallId: p.itemId }));
                    break;
                }
                case CODEX_METHODS.patchUpdated: {
                    const p = params as FileChangePatchUpdatedNotification;
                    if (calls.has(p.itemId)) emitDiffs(p.itemId, p.changes);
                    break;
                }
                case CODEX_METHODS.turnPlan: {
                    const p = params as TurnPlanUpdatedNotification;
                    emit(codingEvent('plan', { entries: p.plan.map((s) => ({ content: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status })) }));
                    break;
                }
                case CODEX_METHODS.turnDiff:
                    emit({ type: 'ext', ns: CODEX_NS, name: 'turn-diff', data: { diff: (params as TurnDiffUpdatedNotification).diff } });
                    break;
                case CODEX_METHODS.tokenUsage: {
                    // A sub-agent's tokens are its own, reported on the agent by the session.
                    if (nested) break;
                    const p = params as ThreadTokenUsageUpdatedNotification;
                    turnUsage = toUsage(p.tokenUsage.last);
                    emit({ type: 'usage', scope: 'turn', usage: turnUsage });
                    emit({ type: 'usage', scope: 'session', usage: toUsage(p.tokenUsage.total) });
                    break;
                }
                case CODEX_METHODS.error: {
                    // A sub-agent's error would read as the host session's own.
                    if (nested) break;
                    const p = params as ErrorNotification;
                    emit({ type: 'error', code: toErrorCode(p.error.codexErrorInfo), message: p.error.message, recoverable: p.willRetry });
                    break;
                }
                case CODEX_METHODS.turnCompleted: {
                    const p = params as TurnCompletedNotification;
                    for (const [partId, part] of Array.from(parts)) closePart(partId, part.kind, '');
                    const stopReason = toStopReason(p.turn.status);
                    // An interrupt stops the sub-agents with the turn; otherwise they may run on.
                    // A sub-agent's own interrupted turn is not the host's: the session settles that agent.
                    if (stopReason === 'cancelled' && !nested) settleSubAgents(agents, 'cancelled', emit);
                    const error = p.turn.error ? { code: toErrorCode(p.turn.error.codexErrorInfo), message: p.turn.error.message } : undefined;
                    if (stopReason === 'error' && error && !nested) emit({ type: 'error', code: error.code, message: error.message, recoverable: false });
                    resolveOutcome({ stopReason, ...(error ? { error } : {}), finalText, ...(turnUsage ? { usage: turnUsage } : {}) });
                    break;
                }
                case CODEX_METHODS.turnStarted:
                case CODEX_METHODS.mcpProgress:
                    break;
                default:
                    emit({ type: 'ext', ns: CODEX_NS, name: method, data: params ?? null });
            }
        }
    };
}
