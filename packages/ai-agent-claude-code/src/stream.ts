/**
 * SDK messages → agent events, for one turn. The same state machine the
 * Anthropic provider keeps for a Messages stream (open blocks by index), plus
 * Claude Code's own frames: tool results arriving as user messages, progress,
 * subagents (`parent_tool_use_id`), the `result` that ends a turn, and the
 * session-level frames (`system/init`, rate limits, auth) that become
 * `config`, `error` or `ext` events.
 */

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { parsePartialJson, type Usage } from '@sigx/ai';
import type { AgentErrorCode, StopReason, TurnDriver, UnstampedEvent } from '@sigx/ai-agent';
import { codingEvent, type CodingPlanEntry } from '@sigx/ai-agent/coding';
import { categoryFor, configOptions, splitToolName, toolAnnotations, type ConfigTracker } from './request.js';
import { toUsage, type AgentTracker } from './tasks.js';

export const CLAUDE_CODE_NS = 'claude-code';

/** Where a session-level event goes when no turn is running. */
export type Emit = (event: UnstampedEvent) => void;

export interface TurnMapperOptions {
    readonly driver: TurnDriver;
    readonly serverName: string;
    /** The session's sub-agents — task frames and Task results fold into it. */
    readonly tracker: AgentTracker;
    /** Called with the result that ended the turn. */
    readonly onResult: (result: SDKResultMessage) => void;
    /** `true` once we asked the CLI to interrupt — `error_during_execution` then means `cancelled`. */
    readonly interrupted: () => boolean;
    /** The cumulative cost the previous result reported, to make `turn-end.costUsd` a delta. */
    readonly previousCostUsd: () => number;
    /** The session's advertised settings, for the `config` event `system/init` becomes. */
    readonly config?: ConfigTracker;
}

interface OpenBlock {
    kind: 'text' | 'thinking' | 'tool_use';
    partId?: string;
    thinking?: string;
    signature?: string;
    id?: string;
    name?: string;
    json?: string;
}

interface Block {
    readonly type: string;
    readonly [key: string]: unknown;
}

export interface TurnMapper {
    /** Feed one SDK message that belongs to this turn. */
    handle(message: SDKMessage): void;
    /** A tool use the turn announced, by SDK tool name + input identity (for `canUseTool` before the id is known). */
    callIdFor(toolName: string, input: unknown): string | undefined;
    /** We denied this call: its tool result is a `denied` update, not a failure. */
    markDenied(toolName: string, input: unknown, callId?: string): void;
}

export function createTurnMapper(options: TurnMapperOptions): TurnMapper {
    const { driver, serverName, tracker } = options;
    const emit: Emit = (e) => driver.emit(e);
    let messageIndex = 0;
    let messageId = `a:${driver.turnId}:0`;
    let partSeq = 0;
    let streamedThisMessage = false;
    const open = new Map<number, OpenBlock>();
    const calls = new Map<string, { name: string; input: unknown; started: boolean; parent: string | undefined }>();
    const denied = new Set<string>();
    const settled = new Set<string>();
    /** Denials decided before the call id was known (the SDK asked first) — matched on the announcement. */
    const deniedPending: { name: string; input: string }[] = [];

    const nextPartId = () => `${messageId}:${partSeq++}`;
    const parentOf = (m: { parent_tool_use_id?: string | null }) => (m.parent_tool_use_id ? { parentCallId: m.parent_tool_use_id } : {});
    /** A nested part's context: the spawning call, and the sub-agent type as its actor. */
    const nestedIn = (parent: string | null | undefined, actor?: string) => (parent ? { parentCallId: parent, actor: actor ?? tracker.actorFor(parent) ?? 'subagent' } : {});

    const announceCall = (id: string, rawName: string, input: unknown, parent: string | null | undefined) => {
        if (calls.has(id)) return;
        const { name } = splitToolName(rawName, serverName);
        const annotations = toolAnnotations(name);
        const category = categoryFor(name);
        calls.set(id, { name: rawName, input, started: false, parent: parent ?? undefined });
        const serialized = JSON.stringify(input);
        const pending = deniedPending.findIndex((d) => d.name === rawName && d.input === serialized);
        if (pending >= 0) {
            deniedPending.splice(pending, 1);
            denied.add(id);
        }
        driver.emit({
            type: 'tool-call',
            callId: id,
            name,
            messageId,
            input,
            ...(annotations ? { annotations } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(parent ? { parentCallId: parent } : {})
        });
        driver.emit({ type: 'tool-update', callId: id, status: 'pending', ...(parent ? { parentCallId: parent } : {}) });
    };

    const startMessage = (parent: string | null | undefined) => {
        messageId = `a:${driver.turnId}:${messageIndex++}`;
        partSeq = 0;
        streamedThisMessage = false;
        open.clear();
        void parent;
    };

    const emitTextPart = (kind: 'text' | 'reasoning', text: string, providerData: unknown, parent: string | null | undefined, actor?: string) => {
        const partId = nextPartId();
        driver.emit({ type: 'part-start', messageId, partId, kind, ...nestedIn(parent, actor) });
        if (text) driver.emit({ type: 'part-delta', partId, delta: text, ...(parent ? { parentCallId: parent } : {}) });
        driver.emit({ type: 'part-end', partId, ...(providerData !== undefined ? { providerData } : {}), ...(parent ? { parentCallId: parent } : {}) });
    };

    const settleToolResult = (block: Block, parent: string | null | undefined, toolUseResult: unknown) => {
        const id = String(block.tool_use_id);
        const call = calls.get(id);
        const content = block.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Block[]).filter((c) => c.type === 'text').map((c) => String(c.text)).join('\n') : '';
        const isError = block.is_error === true;
        const pc = parent ? { parentCallId: parent } : {};
        settled.add(id);
        // A Task call's result ends the sub-agent it spawned (or sends it to the background) — before the call itself settles.
        tracker.settleCall(id, toolUseResult, text, isError, emit);
        if (call && !isError) emitCodingExtras(driver, call.name, call.input, id);
        if (denied.has(id)) driver.emit({ type: 'tool-update', callId: id, status: 'denied', error: text, ...pc });
        else driver.emit(isError ? { type: 'tool-update', callId: id, status: 'failed', error: text, ...pc } : { type: 'tool-update', callId: id, status: 'completed', output: text, ...pc });
    };

    const handleStreamEvent = (event: Block, parent: string | null | undefined) => {
        const pc = parent ? { parentCallId: parent } : {};
        switch (event.type) {
            case 'message_start':
                startMessage(parent);
                streamedThisMessage = true;
                break;
            case 'content_block_start': {
                streamedThisMessage = true;
                const index = Number(event.index);
                const block = event.content_block as Block;
                if (block.type === 'text') {
                    const partId = nextPartId();
                    open.set(index, { kind: 'text', partId });
                    driver.emit({ type: 'part-start', messageId, partId, kind: 'text', ...nestedIn(parent) });
                } else if (block.type === 'thinking') {
                    const partId = nextPartId();
                    open.set(index, { kind: 'thinking', partId, thinking: '', signature: '' });
                    driver.emit({ type: 'part-start', messageId, partId, kind: 'reasoning', ...nestedIn(parent) });
                } else if (block.type === 'redacted_thinking') {
                    emitTextPart('reasoning', '', block, parent);
                } else if (block.type === 'tool_use') {
                    open.set(index, { kind: 'tool_use', id: String(block.id), name: String(block.name), json: '' });
                }
                break;
            }
            case 'content_block_delta': {
                const b = open.get(Number(event.index));
                const delta = event.delta as Block;
                if (!b) break;
                // An EMPTY delta is not an event: Claude Code redacts thinking
                // text and still streams one `thinking_delta` per progress tick
                // with `thinking: ''` (issue #77), which would cost a `seq`,
                // replay and coalesce while saying nothing. The text is still
                // accumulated, so a harness that does expose it is unaffected.
                if (delta.type === 'text_delta' && b.kind === 'text') {
                    const text = String(delta.text);
                    if (text) driver.emit({ type: 'part-delta', partId: b.partId!, delta: text, ...pc });
                } else if (delta.type === 'thinking_delta' && b.kind === 'thinking') {
                    const text = String(delta.thinking);
                    b.thinking = (b.thinking ?? '') + text;
                    if (text) driver.emit({ type: 'part-delta', partId: b.partId!, delta: text, ...pc });
                } else if (delta.type === 'signature_delta' && b.kind === 'thinking') b.signature = (b.signature ?? '') + String(delta.signature);
                else if (delta.type === 'input_json_delta' && b.kind === 'tool_use') b.json = (b.json ?? '') + String(delta.partial_json);
                break;
            }
            case 'content_block_stop': {
                const index = Number(event.index);
                const b = open.get(index);
                if (!b) break;
                open.delete(index);
                if (b.kind === 'text') driver.emit({ type: 'part-end', partId: b.partId!, ...pc });
                else if (b.kind === 'thinking') driver.emit({ type: 'part-end', partId: b.partId!, providerData: { type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' }, ...pc });
                else if (b.kind === 'tool_use') {
                    let input: unknown = {};
                    if (b.json) {
                        try {
                            input = JSON.parse(b.json);
                        } catch {
                            input = parsePartialJson(b.json) ?? {};
                        }
                    }
                    announceCall(b.id!, b.name!, input, parent);
                }
                break;
            }
            default:
                break;
        }
    };

    return {
        callIdFor(toolName, input) {
            for (const [id, call] of calls) if (call.name === toolName && !call.started && JSON.stringify(call.input) === JSON.stringify(input)) return id;
            return undefined;
        },
        markDenied(toolName, input, callId) {
            if (callId) denied.add(callId);
            else deniedPending.push({ name: toolName, input: JSON.stringify(input) });
        },
        handle(message) {
            switch (message.type) {
                case 'stream_event':
                    handleStreamEvent(message.event as unknown as Block, message.parent_tool_use_id);
                    break;
                case 'assistant': {
                    const parent = message.parent_tool_use_id;
                    const actor = (message as { subagent_type?: string }).subagent_type;
                    const content = (message.message as unknown as { content?: Block[] }).content ?? [];
                    if (!streamedThisMessage) {
                        // No partial frames for this message: build the parts from the whole message.
                        startMessage(parent);
                        for (const block of content) {
                            if (block.type === 'text') emitTextPart('text', String(block.text), undefined, parent, actor);
                            else if (block.type === 'thinking') emitTextPart('reasoning', String(block.thinking), { type: 'thinking', thinking: block.thinking, signature: block.signature }, parent, actor);
                            else if (block.type === 'redacted_thinking') emitTextPart('reasoning', '', block, parent, actor);
                        }
                    }
                    // Reconcile: every tool use is announced exactly once, with the final input.
                    for (const block of content) if (block.type === 'tool_use') announceCall(String(block.id), String(block.name), block.input, parent);
                    if (message.error) emitAssistantError(driver, message.error);
                    streamedThisMessage = false;
                    break;
                }
                case 'user': {
                    const content = (message.message as { content?: unknown }).content;
                    if (!Array.isArray(content)) break;
                    const results = (content as Block[]).filter((block) => block.type === 'tool_result');
                    // The structured `tool_use_result` rides the frame, not the block: it belongs to the one result the frame carries.
                    const structured = results.length === 1 ? (message as { tool_use_result?: unknown }).tool_use_result : undefined;
                    for (const block of results) settleToolResult(block, message.parent_tool_use_id, structured);
                    break;
                }
                case 'tool_progress': {
                    const call = calls.get(message.tool_use_id);
                    if (call && !call.started) {
                        call.started = true;
                        driver.emit({ type: 'tool-update', callId: message.tool_use_id, status: 'in_progress', ...parentOf(message) });
                    }
                    break;
                }
                case 'result': {
                    // A call the result left unsettled is over one way or another.
                    const aborted = options.interrupted() || driver.signal.aborted;
                    for (const [id, call] of calls) {
                        if (settled.has(id)) continue;
                        settled.add(id);
                        const pc = call.parent ? { parentCallId: call.parent } : {};
                        driver.emit(aborted ? { type: 'tool-update', callId: id, status: 'cancelled', ...pc } : { type: 'tool-update', callId: id, status: 'failed', error: 'The turn ended before the tool call was settled.', ...pc });
                    }
                    // So is a foreground sub-agent; a background one runs on past the turn.
                    tracker.sweep(aborted ? 'cancelled' : 'failed', emit, { background: false, message: 'The turn ended before the sub-agent finished.' });
                    emitResult(driver, message, options);
                    options.onResult(message);
                    break;
                }
                case 'system':
                    if (!tracker.handleTask(message, emit, (id) => calls.has(id))) mapSessionMessage(message, emit, options.config);
                    break;
                default:
                    mapSessionMessage(message, emit, options.config);
            }
        }
    };
}

/** The extras a built-in tool's input tells us about: an edit is a diff, a todo list is a plan. */
function emitCodingExtras(driver: TurnDriver, rawName: string, input: unknown, callId: string): void {
    if (typeof input !== 'object' || input === null) return;
    const r = input as Record<string, unknown>;
    const path = typeof r.file_path === 'string' ? r.file_path : undefined;
    if ((rawName === 'Edit' || rawName === 'MultiEdit') && path) {
        const edits = Array.isArray(r.edits) ? (r.edits as Record<string, unknown>[]) : [r];
        for (const e of edits) {
            driver.emit(codingEvent('diff', { path, ...(typeof e.old_string === 'string' ? { oldText: e.old_string } : {}), ...(typeof e.new_string === 'string' ? { newText: e.new_string } : {}) }, { parentCallId: callId }));
        }
    } else if (rawName === 'Write' && path) {
        driver.emit(codingEvent('diff', { path, ...(typeof r.content === 'string' ? { newText: r.content } : {}) }, { parentCallId: callId }));
    } else if (rawName === 'TodoWrite' && Array.isArray(r.todos)) {
        const entries: CodingPlanEntry[] = (r.todos as Record<string, unknown>[]).map((t) => {
            const status: CodingPlanEntry['status'] = t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending';
            const priority = t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? (t.priority as CodingPlanEntry['priority']) : undefined;
            return { content: String(t.content ?? ''), status, ...(priority ? { priority } : {}) };
        });
        driver.emit(codingEvent('plan', { entries }, { parentCallId: callId }));
    }
}

function emitAssistantError(driver: TurnDriver, error: string): void {
    const { code, recoverable } = assistantErrorCode(error);
    driver.emit({ type: 'error', code, message: `Claude Code reported: ${error}`, recoverable });
}

export function assistantErrorCode(error: string): { code: AgentErrorCode; recoverable: boolean } {
    switch (error) {
        case 'authentication_failed':
        case 'oauth_org_not_allowed':
        case 'account_on_hold':
        case 'billing_error':
        case 'verification_required':
        case 'cloud_credential_error':
            return { code: 'auth_required', recoverable: false };
        case 'rate_limit':
        case 'overloaded':
            return { code: 'rate_limited', recoverable: true };
        default:
            return { code: 'provider_error', recoverable: false };
    }
}

function emitResult(driver: TurnDriver, result: SDKResultMessage, options: TurnMapperOptions): void {
    const usage = toUsage(result.usage as unknown as Record<string, unknown> | undefined);
    const total = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined;
    const delta = total !== undefined ? Math.max(0, total - options.previousCostUsd()) : undefined;
    // A turn-scope `usage` event ADDS, and the estimate already streamed
    // frame by frame while the thinking block ran — so the billed
    // `reasoningTokens` is left out of this one and lands only where usage is
    // ASSIGNED: the session-scope event below (which replaces the running
    // estimate with the real figure) and the `turn-end` record.
    if (usage) driver.emit({ type: 'usage', scope: 'turn', usage: withoutReasoning(usage), ...(delta !== undefined ? { costUsd: delta } : {}) });
    if (total !== undefined) driver.emit({ type: 'usage', scope: 'session', usage: sessionUsage(result), costUsd: total });

    let stopReason: StopReason;
    let error: { code: AgentErrorCode; message: string } | undefined;
    const terminal = (result as { terminal_reason?: string }).terminal_reason;
    if (result.subtype === 'success') {
        stopReason = result.stop_reason === 'max_tokens' ? 'max_tokens' : result.stop_reason === 'refusal' ? 'refusal' : 'end_turn';
        if (result.is_error) {
            error = { code: 'provider_error', message: result.result || 'Claude Code reported an error.' };
            stopReason = 'error';
        }
    } else if (result.subtype === 'error_max_turns') stopReason = 'max_turns';
    else if (result.subtype === 'error_during_execution' && options.interrupted()) stopReason = 'cancelled';
    else {
        const message = result.errors?.length ? result.errors.join('; ') : `Claude Code ended the turn: ${result.subtype}`;
        error = { code: terminal === 'prompt_too_long' ? 'context_exceeded' : 'provider_error', message };
        stopReason = 'error';
    }
    if (terminal === 'prompt_too_long' && !error) error = { code: 'context_exceeded', message: 'The conversation no longer fits the model context.' };
    if (error) driver.emit({ type: 'error', code: error.code, message: error.message, recoverable: false });

    const output = result.subtype === 'success' ? (result as { structured_output?: unknown }).structured_output : undefined;
    driver.end({
        stopReason: error ? 'error' : stopReason,
        ...(usage ? { usage } : {}),
        ...(delta !== undefined ? { costUsd: delta } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(error ? { error } : {})
    });
}

/** The same usage without the reasoning breakdown — for the additive turn-scope event. */
function withoutReasoning(usage: Usage): Usage {
    const { reasoningTokens: _streamed, ...rest } = usage;
    return rest;
}

/** Cumulative tokens across every model call of the query (`modelUsage`), summed. */
function sessionUsage(result: SDKResultMessage): Usage {
    const out: Usage = {};
    const models = (result as { modelUsage?: Record<string, Record<string, unknown>> }).modelUsage ?? {};
    for (const m of Object.values(models)) {
        for (const [k, to] of [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['cacheReadInputTokens', 'cacheReadInputTokens'], ['cacheCreationInputTokens', 'cacheCreationInputTokens'], ['thinkingTokens', 'reasoningTokens']] as const) {
            if (typeof m[k] === 'number') out[to] = (out[to] ?? 0) + (m[k] as number);
        }
    }
    return out;
}

/** Frames that are not about a turn: config, state, rate limits, auth — or an `ext`. */
export function mapSessionMessage(message: SDKMessage, emit: Emit, config?: ConfigTracker): void {
    const strip = (m: object) => {
        const { uuid: _u, session_id: _s, ...rest } = m as Record<string, unknown>;
        return rest;
    };
    switch (message.type) {
        case 'system': {
            const m = message as { subtype: string } & Record<string, unknown>;
            if (m.subtype === 'init') {
                // `init` is the CLI's word on the model and the mode, so it
                // wins over whatever the session had recorded. It says
                // nothing about thinking — the display is ours, from the
                // session options (or the last `configure()`), and is left
                // out when we cannot know it (thinking disabled, or
                // inherited from the CLI's own settings).
                const next = { model: String(m.model ?? ''), permissionMode: String(m.permissionMode ?? 'default') };
                emit({ type: 'config', options: configOptions(config ? config.update(next) : next) });
            } else if (m.subtype === 'session_state_changed') {
                if (m.state === 'requires_action') emit({ type: 'state', value: 'awaiting' });
            } else if (m.subtype === 'permission_denied') {
                emit({ type: 'tool-update', callId: String(m.tool_use_id), status: 'denied', error: `Tool "${String(m.tool_name)}" was denied by Claude Code's settings.` });
            } else if (m.subtype === 'thinking_tokens') {
                // The ONLY live signal that a redacted thinking block is
                // running. `estimated_tokens_delta` is this frame's increment
                // and turn-scope usage is additive, so the neutral
                // `reasoningTokens` key grows while the block streams and any
                // client — not just one that knows this namespace — can show
                // progress. It is the CLI's own estimate ("for spinners/pills",
                // says the SDK); the billed count arrives with the result and
                // supersedes it there (see `emitResult`). The raw frame still
                // goes out as an `ext` for clients that want `estimated_tokens`.
                const delta = (m as { estimated_tokens_delta?: unknown }).estimated_tokens_delta;
                if (typeof delta === 'number' && delta > 0) emit({ type: 'usage', scope: 'turn', usage: { reasoningTokens: delta } });
                emit({ type: 'ext', ns: CLAUDE_CODE_NS, name: m.subtype, data: strip(m) });
            } else emit({ type: 'ext', ns: CLAUDE_CODE_NS, name: m.subtype, data: strip(m) });
            break;
        }
        case 'rate_limit_event': {
            const info = (message as { rate_limit_info?: { status?: string } }).rate_limit_info;
            if (info?.status === 'rejected') emit({ type: 'error', code: 'rate_limited', message: 'Claude Code hit a rate limit.', recoverable: true, data: info });
            else emit({ type: 'ext', ns: CLAUDE_CODE_NS, name: 'rate-limit', data: strip(message) });
            break;
        }
        case 'auth_status': {
            const m = message as { error?: string; output?: string[] };
            if (m.error) emit({ type: 'error', code: 'auth_required', message: m.error, recoverable: false, data: { output: m.output } });
            else emit({ type: 'ext', ns: CLAUDE_CODE_NS, name: 'auth-status', data: strip(message) });
            break;
        }
        default:
            emit({ type: 'ext', ns: CLAUDE_CODE_NS, name: (message as { subtype?: string }).subtype ?? message.type, data: strip(message) });
    }
}
