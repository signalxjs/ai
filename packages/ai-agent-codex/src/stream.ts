/**
 * Codex notifications → agent events, for one turn. A state machine over
 * items: agent messages and reasoning become parts (opened on `item/started`
 * or the first delta, closed on `item/completed`), command executions, file
 * changes and tool calls become `tool-call` / `tool-update` with the coding
 * extension events alongside, plans become `coding.plan`, and anything we do
 * not model is passed through as `ext { ns: 'codex' }`.
 */

import type { Usage } from '@sigx/ai';
import type { AgentErrorCode, StopReason, ToolStatus, UnstampedEvent } from '@sigx/ai-agent';
import type { TurnDriver } from '@sigx/ai-agent';
import { codingEvent } from '@sigx/ai-agent/coding';
import { CODEX_METHODS } from './schema.js';
import type {
    CodexErrorInfo,
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

export function toUsage(u: TokenUsageBreakdown): Usage {
    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens,
        cachedInputTokens: u.cachedInputTokens,
        cacheWriteInputTokens: u.cacheWriteInputTokens,
        reasoningOutputTokens: u.reasoningOutputTokens
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

export function createTurnMapper(driver: TurnDriver, options: { readonly messageId: string }): TurnMapper {
    const { messageId } = options;
    /** Open text/reasoning parts by part id, with how much of them has been streamed. */
    const parts = new Map<string, { kind: 'text' | 'reasoning'; streamed: number }>();
    /** Item ids of tool calls announced, so updates for unknown items are ignored. */
    const calls = new Set<string>();
    /** Calls the policy denied — Codex still reports them `failed`, which must not follow `denied`. */
    const denied = new Set<string>();
    const diffsEmitted = new Set<string>();
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
        emit({ type: 'part-start', messageId, partId, kind });
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
                case CODEX_METHODS.agentMessageDelta: {
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
                    const p = params as ThreadTokenUsageUpdatedNotification;
                    turnUsage = toUsage(p.tokenUsage.last);
                    emit({ type: 'usage', scope: 'turn', usage: turnUsage });
                    emit({ type: 'usage', scope: 'session', usage: toUsage(p.tokenUsage.total) });
                    break;
                }
                case CODEX_METHODS.error: {
                    const p = params as ErrorNotification;
                    emit({ type: 'error', code: toErrorCode(p.error.codexErrorInfo), message: p.error.message, recoverable: p.willRetry });
                    break;
                }
                case CODEX_METHODS.turnCompleted: {
                    const p = params as TurnCompletedNotification;
                    for (const [partId, part] of Array.from(parts)) closePart(partId, part.kind, '');
                    const stopReason = toStopReason(p.turn.status);
                    const error = p.turn.error ? { code: toErrorCode(p.turn.error.codexErrorInfo), message: p.turn.error.message } : undefined;
                    if (stopReason === 'error' && error) emit({ type: 'error', code: error.code, message: error.message, recoverable: false });
                    resolveOutcome({ stopReason, ...(error ? { error } : {}), finalText, ...(turnUsage ? { usage: turnUsage } : {}) });
                    break;
                }
                case CODEX_METHODS.turnStarted:
                case CODEX_METHODS.mcpProgress:
                case CODEX_METHODS.planDelta:
                    break;
                default:
                    emit({ type: 'ext', ns: CODEX_NS, name: method, data: params ?? null });
            }
        }
    };
}
