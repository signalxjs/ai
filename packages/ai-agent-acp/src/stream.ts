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
        // The well-known `Usage` keys, not ACP's own spellings — see `Usage`
        // in `@sigx/ai`.
        ...(typeof u.thoughtTokens === 'number' ? { reasoningTokens: u.thoughtTokens } : {}),
        ...(typeof u.cachedReadTokens === 'number' ? { cacheReadInputTokens: u.cachedReadTokens } : {}),
        ...(typeof u.cachedWriteTokens === 'number' ? { cacheCreationInputTokens: u.cachedWriteTokens } : {})
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

/** The id the session's own ACP modes are advertised under. */
export const ACP_MODE_ID = 'mode';
const MODE_LABEL = 'Mode';
/** Used only when an agent declares an option that would render as "Mode" too. */
const MODE_LABEL_QUALIFIED = 'Session mode';

/**
 * Where an emitted `ConfigOption` came from. Deliberately NOT a field on
 * `ConfigOption` — that shape is the contract in `@sigx/ai-agent`. This is the
 * adapter's own side table, so `configure()` routes on ORIGIN rather than on
 * the literal key `mode`.
 */
export type AcpConfigOrigin = { readonly kind: 'mode'; readonly modes: AcpSessionModeState } | { readonly kind: 'option'; readonly option: AcpSessionConfigOption };

export interface AcpConfigView {
    /** The `config` event payload. */
    readonly options: readonly ConfigOption[];
    /** Emitted id → what it drives. One entry per `options` entry. */
    readonly origins: ReadonlyMap<string, AcpConfigOrigin>;
}

/**
 * Modes and config options as one `config` event payload, plus where each
 * entry came from.
 *
 * An agent may declare a config option of its own called `mode` (GitHub
 * Copilot's ACP server does) while the session also has ACP modes. They are
 * two different settings, so both stay reachable and neither shadows the
 * other — `ConfigOption.id` is what `configure()` addresses, so emitting it
 * twice is a contract violation however the two render.
 *
 * The two halves of the collision are resolved in opposite directions, each
 * the way it costs least:
 *
 * - `mode` keeps meaning the ACP SESSION mode. It is what every client and
 *   `configure({ mode })` has always meant, so the colliding agent option is
 *   namespaced instead (`acp:mode`).
 * - The LABELS go the other way: an agent's own name is not ours to rewrite,
 *   so when both would render as "Mode" it is OUR generic label that gets
 *   specific. Keyed on the label, not the id — an option `{ id: 'reasoning',
 *   name: 'Mode' }` puts two identical dropdowns on screen just as surely.
 *
 * With no collision nothing moves.
 */
export function toConfigView(modes: AcpSessionModeState | null | undefined, options: readonly AcpSessionConfigOption[] | null | undefined): AcpConfigView {
    const out: ConfigOption[] = [];
    const origins = new Map<string, AcpConfigOrigin>();
    const declared = options ?? [];
    if (modes) {
        out.push({
            id: ACP_MODE_ID,
            label: declared.some((o) => o.name === MODE_LABEL) ? MODE_LABEL_QUALIFIED : MODE_LABEL,
            values: modes.availableModes.map((m) => ({ id: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) })),
            current: modes.currentModeId
        });
        origins.set(ACP_MODE_ID, { kind: 'mode', modes });
    }
    const ids = assignIds(declared, origins);
    declared.forEach((o, i) => {
        const id = ids[i]!;
        out.push(
            o.type === 'select'
                ? {
                      id,
                      label: o.name,
                      values: o.options.map((v) => ({ id: v.value, label: v.name, ...(v.description ? { description: v.description } : {}) })),
                      current: o.currentValue
                  }
                : { id, label: o.name, values: [{ id: 'true' }, { id: 'false' }], current: String(o.currentValue) }
        );
        origins.set(id, { kind: 'option', option: o });
    });
    return { options: out, origins };
}

/**
 * The id to advertise each agent-declared option under, in declaration order.
 *
 * Two passes, so the id a client must send does not depend on the order the
 * agent happened to declare its options in. Pass one settles every option that
 * collides with an id WE reserved (`mode`): those always become `acp:<id>`, so
 * an agent that also ships an option literally called `acp:mode` cannot take
 * that name first and push the real collision to `acp:mode:2`. Pass two gives
 * everything else its own id, namespacing only what is by then taken.
 */
function assignIds(declared: readonly AcpSessionConfigOption[], reserved: ReadonlyMap<string, unknown>): string[] {
    const taken = new Set(reserved.keys());
    const ids = new Array<string | undefined>(declared.length);
    declared.forEach((o, i) => {
        if (reserved.has(o.id)) ids[i] = claim(namespaced(o.id), taken, o.id);
    });
    declared.forEach((o, i) => {
        if (ids[i] === undefined) ids[i] = claim(taken.has(o.id) ? namespaced(o.id) : o.id, taken, o.id);
    });
    return ids as string[];
}

const namespaced = (id: string) => `${ACP_NS}:${id}`;

/** A taken id is counted off, never dropped: two settings mean two controls. */
function claim(wanted: string, taken: Set<string>, source: string): string {
    let id = wanted;
    for (let n = 2; taken.has(id); n++) id = `${namespaced(source)}:${n}`;
    taken.add(id);
    return id;
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
