/**
 * ACP ↔ contract mapping — pure functions and the per-turn update mapper.
 * Nothing here talks to a peer; `session.ts` wires it up.
 */

import type { Usage } from '@sigx/ai';
import type { ConfigOption, ContentBlock, Decision, PromptPart, StopReason, ToolStatus, TurnDriver } from '@sigx/ai-agent';
import { codingEvent, isCodingCategory } from '@sigx/ai-agent/coding';
import type {
    AcpContentBlock,
    AcpPermissionOption,
    AcpRequestPermissionOutcome,
    AcpSessionConfigOption,
    AcpSessionModeState,
    AcpSessionUpdate,
    AcpStopReason,
    AcpToolCallContent,
    AcpToolCallStatus,
    AcpToolKind,
    AcpUsage
} from './schema.js';

export const ACP_NS = 'acp';

// ── Prompts and content ─────────────────────────────────────────────────

/** A prompt's parts as ACP content blocks. */
export function toAcpBlocks(parts: readonly PromptPart[]): AcpContentBlock[] {
    const out: AcpContentBlock[] = [];
    for (const p of parts) {
        switch (p.type) {
            case 'text':
                out.push({ type: 'text', text: p.text });
                break;
            case 'image':
                if (p.data !== undefined) out.push({ type: 'image', data: p.data, mimeType: p.mediaType, ...(p.url !== undefined ? { uri: p.url } : {}) });
                else if (p.url !== undefined) out.push({ type: 'resource_link', uri: p.url, name: p.url, mimeType: p.mediaType });
                break;
            case 'file': {
                const uri = p.url ?? `file:///${encodeURIComponent(p.filename ?? 'file')}`;
                if (p.data !== undefined) out.push({ type: 'resource', resource: { uri, mimeType: p.mediaType, blob: p.data } });
                else out.push({ type: 'resource_link', uri, name: p.filename ?? uri, mimeType: p.mediaType });
                break;
            }
            case 'resource':
                if (p.text !== undefined) out.push({ type: 'resource', resource: { uri: p.uri, ...(p.mediaType !== undefined ? { mimeType: p.mediaType } : {}), text: p.text } });
                else out.push({ type: 'resource_link', uri: p.uri, name: p.name ?? p.uri, ...(p.mediaType !== undefined ? { mimeType: p.mediaType } : {}) });
                break;
        }
    }
    return out;
}

/** An ACP content block as a prompt part (for replayed user messages). */
export function toPromptPart(block: AcpContentBlock): PromptPart | undefined {
    switch (block.type) {
        case 'text':
            return { type: 'text', text: block.text };
        case 'image':
            return { type: 'image', mediaType: block.mimeType, data: block.data };
        case 'resource_link':
            return { type: 'resource', uri: block.uri, name: block.name, ...(block.mimeType ? { mediaType: block.mimeType } : {}) };
        case 'resource':
            return 'text' in block.resource
                ? { type: 'resource', uri: block.resource.uri, text: block.resource.text, ...(block.resource.mimeType ? { mediaType: block.resource.mimeType } : {}) }
                : { type: 'file', mediaType: block.resource.mimeType ?? 'application/octet-stream', data: block.resource.blob, filename: block.resource.uri };
        default:
            return undefined;
    }
}

/** An ACP content block as a tool-result content block. */
export function toContentBlock(block: AcpContentBlock): ContentBlock {
    switch (block.type) {
        case 'text':
            return { type: 'text', text: block.text };
        case 'image':
            return { type: 'image', mediaType: block.mimeType, data: block.data, ...(block.uri ? { url: block.uri } : {}) };
        case 'resource_link':
            return { type: 'resource', uri: block.uri, name: block.name, ...(block.mimeType ? { mediaType: block.mimeType } : {}) };
        case 'resource':
            return {
                type: 'resource',
                uri: block.resource.uri,
                ...(block.resource.mimeType ? { mediaType: block.resource.mimeType } : {}),
                ...('text' in block.resource ? { text: block.resource.text } : {})
            };
        default:
            return { type: 'ext', ns: ACP_NS, name: 'content', data: block };
    }
}

// ── Scalars ──────────────────────────────────────────────────────────────

export function toStopReason(reason: AcpStopReason): StopReason {
    switch (reason) {
        case 'end_turn':
            return 'end_turn';
        case 'max_tokens':
            return 'max_tokens';
        case 'max_turn_requests':
            return 'max_turns';
        case 'refusal':
            return 'refusal';
        case 'cancelled':
            return 'cancelled';
    }
}

export function toUsage(u: AcpUsage): Usage {
    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens,
        ...(typeof u.thoughtTokens === 'number' ? { reasoningTokens: u.thoughtTokens } : {}),
        ...(typeof u.cachedReadTokens === 'number' ? { cachedInputTokens: u.cachedReadTokens } : {}),
        ...(typeof u.cachedWriteTokens === 'number' ? { cacheWriteInputTokens: u.cachedWriteTokens } : {})
    };
}

export function toToolStatus(status: AcpToolCallStatus | null | undefined): ToolStatus {
    switch (status) {
        case 'in_progress':
            return 'in_progress';
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        default:
            return 'pending';
    }
}

/** ACP kinds map one to one onto coding categories; `switch_mode` is `other`. */
export function toCategory(kind: AcpToolKind | null | undefined): string | undefined {
    if (!kind) return undefined;
    return isCodingCategory(kind) ? kind : 'other';
}

/** Modes and config options as one `config` event payload. */
export function toConfigOptions(modes: AcpSessionModeState | null | undefined, options: readonly AcpSessionConfigOption[] | null | undefined): ConfigOption[] {
    const out: ConfigOption[] = [];
    if (modes) {
        out.push({
            id: 'mode',
            label: 'Mode',
            values: modes.availableModes.map((m) => ({ id: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) })),
            current: modes.currentModeId
        });
    }
    for (const o of options ?? []) {
        if (o.type === 'select') {
            out.push({
                id: o.id,
                label: o.name,
                values: o.options.map((v) => ({ id: v.value, label: v.name, ...(v.description ? { description: v.description } : {}) })),
                current: o.currentValue
            });
        } else {
            out.push({ id: o.id, label: o.name, values: [{ id: 'true' }, { id: 'false' }], current: String(o.currentValue) });
        }
    }
    return out;
}

/** The permission option a decision selects, or `cancelled`. */
export function toPermissionOutcome(decision: Decision, options: readonly AcpPermissionOption[]): AcpRequestPermissionOutcome {
    const pick = (...kinds: AcpPermissionOption['kind'][]) => {
        for (const kind of kinds) {
            const o = options.find((x) => x.kind === kind);
            if (o) return { outcome: 'selected' as const, optionId: o.optionId };
        }
        return undefined;
    };
    if (decision.type === 'permission') {
        const chosen =
            decision.outcome === 'allow' ? (decision.scope === 'session' ? pick('allow_always', 'allow_once') : pick('allow_once', 'allow_always')) : pick('reject_once', 'reject_always');
        return chosen ?? { outcome: 'cancelled' };
    }
    return { outcome: 'cancelled' };
}

// ── The per-turn update mapper ──────────────────────────────────────────

export interface UpdateMapperOptions {
    readonly turnId: string;
}

/**
 * Folds `session/update` notifications of one prompt into driver events.
 * Text and thought chunks open parts (a new one on a `messageId` change or a
 * kind change); tool calls announce and update; diffs, plans and terminals
 * become `coding.*` extension events; the rest stays visible as `acp.*` ext.
 */
export function createUpdateMapper(driver: TurnDriver, options: UpdateMapperOptions) {
    const { turnId } = options;
    let messageSeq = 0;
    let partSeq = 0;
    let currentMessage: { acpId: string | null | undefined; id: string } | undefined;
    let open: { partId: string; kind: 'text' | 'reasoning' } | undefined;
    const knownCalls = new Set<string>();

    const messageFor = (acpId: string | null | undefined): string => {
        if (currentMessage && (acpId == null || currentMessage.acpId === acpId)) return currentMessage.id;
        closePart();
        currentMessage = { acpId: acpId ?? undefined, id: `a:${turnId}:${messageSeq++}` };
        return currentMessage.id;
    };
    const closePart = () => {
        if (!open) return;
        driver.emit({ type: 'part-end', partId: open.partId });
        open = undefined;
    };
    const delta = (kind: 'text' | 'reasoning', text: string, acpMessageId: string | null | undefined) => {
        const messageId = messageFor(acpMessageId);
        if (!open || open.kind !== kind) {
            closePart();
            const partId = `${messageId}:${partSeq++}`;
            open = { partId, kind };
            driver.emit({ type: 'part-start', messageId, partId, kind });
        }
        driver.emit({ type: 'part-delta', partId: open.partId, delta: text });
    };
    const toolContent = (callId: string, content: readonly AcpToolCallContent[] | null | undefined): ContentBlock[] | undefined => {
        if (!content) return undefined;
        const blocks: ContentBlock[] = [];
        for (const c of content) {
            if (c.type === 'content') blocks.push(toContentBlock(c.content));
            else if (c.type === 'diff') {
                driver.emit(codingEvent('diff', { path: c.path, ...(c.oldText != null ? { oldText: c.oldText } : {}), newText: c.newText }, { parentCallId: callId }));
            } else if (c.type === 'terminal') {
                driver.emit({ type: 'ext', ns: ACP_NS, name: 'tool_terminal', data: { toolCallId: callId, terminalId: c.terminalId }, parentCallId: callId });
            }
        }
        return blocks.length ? blocks : undefined;
    };

    return {
        apply(update: AcpSessionUpdate): void {
            switch (update.sessionUpdate) {
                case 'agent_message_chunk':
                case 'agent_thought_chunk': {
                    const kind = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text';
                    if (update.content.type === 'text') delta(kind, update.content.text, update.messageId);
                    else driver.emit({ type: 'ext', ns: ACP_NS, name: 'agent_message_content', data: { messageId: messageFor(update.messageId), content: toContentBlock(update.content) } });
                    break;
                }
                case 'user_message_chunk': {
                    // Echoed input; keep it as an extension so a UI can show what the agent received.
                    driver.emit({ type: 'ext', ns: ACP_NS, name: 'user_message_chunk', data: update });
                    break;
                }
                case 'tool_call': {
                    closePart();
                    const category = toCategory(update.kind);
                    knownCalls.add(update.toolCallId);
                    driver.emit({
                        type: 'tool-call',
                        callId: update.toolCallId,
                        name: update.name ?? update.title,
                        title: update.title,
                        messageId: messageFor(undefined),
                        ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
                        ...(category !== undefined ? { category } : {})
                    });
                    const content = toolContent(update.toolCallId, update.content);
                    driver.emit({
                        type: 'tool-update',
                        callId: update.toolCallId,
                        status: toToolStatus(update.status),
                        ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
                        ...(content ? { content } : {})
                    });
                    break;
                }
                case 'tool_call_update': {
                    if (!knownCalls.has(update.toolCallId)) {
                        // An update for a call announced before this turn (or never): announce it now.
                        knownCalls.add(update.toolCallId);
                        const category = toCategory(update.kind);
                        driver.emit({
                            type: 'tool-call',
                            callId: update.toolCallId,
                            name: update.name ?? update.title ?? update.toolCallId,
                            ...(update.title ? { title: update.title } : {}),
                            messageId: messageFor(undefined),
                            ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
                            ...(category !== undefined ? { category } : {})
                        });
                    }
                    const content = toolContent(update.toolCallId, update.content);
                    driver.emit({
                        type: 'tool-update',
                        callId: update.toolCallId,
                        status: toToolStatus(update.status),
                        ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
                        ...(content ? { content } : {})
                    });
                    break;
                }
                case 'plan':
                    driver.emit(codingEvent('plan', { entries: update.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })) }));
                    break;
                case 'usage_update':
                    driver.emit({
                        type: 'usage',
                        scope: 'session',
                        usage: { contextUsed: update.used, contextSize: update.size },
                        ...(update.cost && update.cost.currency === 'USD' ? { costUsd: update.cost.amount } : {})
                    });
                    break;
                default:
                    driver.emit({ type: 'ext', ns: ACP_NS, name: update.sessionUpdate, data: update });
            }
        },
        /** Close whatever part is still open — called before `turn-end`. */
        finish(): void {
            closePart();
        },
        /** Calls this turn announced that have no terminal status yet are unknown to the mapper; the session tracks statuses. */
        get calls(): ReadonlySet<string> {
            return knownCalls;
        }
    };
}
