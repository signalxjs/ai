/**
 * `reduceAgentEvent` — fold one event into a transcript, IN PLACE.
 *
 * In place, because every surface that renders a transcript (a reactive
 * proxy in `./app`, a terminal, a server-side store) wants the smallest
 * possible write per event — a `part-delta` is one string append. Still
 * deterministic: nothing here reads a clock or generates an id, so replaying
 * the same events over a clone yields a deep-equal transcript, which is what
 * the conformance suite asserts. Callers who want immutability
 * `structuredClone` first.
 *
 * Unknown `ext` namespaces are ignored; a registered extension owns
 * `transcript.ext[ns]`.
 */

import { addUsage } from '@sigx/ai';
import type { AgentEvent, EventOf } from '../protocol/index.js';
import type { AgentMessage, AgentTranscript, ToolPartState } from './transcript.js';

export interface ReducerExtension {
    readonly ns: string;
    /** Called for every `ext` event in this namespace. */
    reduce(transcript: AgentTranscript, event: EventOf<'ext'>): void;
}

export type AgentReducer = (transcript: AgentTranscript, event: AgentEvent) => AgentTranscript;

export interface CreateReducerOptions {
    readonly extensions?: readonly ReducerExtension[];
}

export function createReducer(options: CreateReducerOptions = {}): AgentReducer {
    const extensions = new Map<string, ReducerExtension>();
    for (const x of options.extensions ?? []) extensions.set(x.ns, x);

    return (t, e) => {
        t.epoch = e.epoch;
        t.seq = e.seq;
        switch (e.type) {
            case 'turn-start':
                t.turn = { turnId: e.turnId ?? '' };
                break;
            case 'turn-end': {
                const turn = t.turn && t.turn.turnId === (e.turnId ?? '') ? t.turn : (t.turn = { turnId: e.turnId ?? '' });
                turn.stopReason = e.stopReason;
                if (e.usage !== undefined) turn.usage = e.usage;
                if (e.costUsd !== undefined) turn.costUsd = e.costUsd;
                if (e.output !== undefined) turn.output = e.output;
                if (e.error !== undefined) turn.error = e.error;
                break;
            }
            case 'user-message':
                t.messages.push({
                    id: e.messageId,
                    role: 'user',
                    ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
                    ...(e.parentCallId !== undefined ? { parentCallId: e.parentCallId } : {}),
                    ...(e.author !== undefined ? { author: e.author } : {}),
                    parts: e.parts.map((p) => ({ ...p }))
                });
                break;
            case 'part-start': {
                const message = assistantMessage(t, e.messageId, e);
                message.parts.push(e.kind === 'text' ? { type: 'text', id: e.partId, text: '' } : { type: 'reasoning', id: e.partId, text: '' });
                break;
            }
            case 'part-delta': {
                const part = findPart(t, e.partId);
                if (part) part.text += e.delta;
                break;
            }
            case 'part-end': {
                const part = findPart(t, e.partId);
                if (part && part.type === 'reasoning' && e.providerData !== undefined) part.providerData = e.providerData;
                break;
            }
            case 'tool-call': {
                const message = e.messageId !== undefined ? assistantMessage(t, e.messageId, e) : currentAssistant(t, e);
                message.parts.push({
                    type: 'tool',
                    callId: e.callId,
                    name: e.name,
                    ...(e.input !== undefined ? { input: e.input } : {}),
                    ...(e.title !== undefined ? { title: e.title } : {}),
                    ...(e.annotations !== undefined ? { annotations: e.annotations } : {}),
                    ...(e.category !== undefined ? { category: e.category } : {}),
                    status: 'pending'
                });
                break;
            }
            case 'tool-update': {
                const tool = findTool(t, e.callId);
                if (!tool) break;
                tool.status = e.status;
                if (e.output !== undefined) tool.output = e.output;
                if (e.error !== undefined) tool.error = e.error;
                if (e.content !== undefined) tool.content = e.content;
                break;
            }
            case 'request': {
                t.requests[e.requestId] = {
                    requestId: e.requestId,
                    kind: e.kind,
                    seq: e.seq,
                    ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
                    ...(e.callId !== undefined ? { callId: e.callId } : {}),
                    ...(e.toolName !== undefined ? { toolName: e.toolName } : {}),
                    ...(e.message !== undefined ? { message: e.message } : {}),
                    ...(e.options !== undefined ? { options: e.options } : {}),
                    ...(e.schema !== undefined ? { schema: e.schema } : {}),
                    ...(e.permissionKey !== undefined ? { permissionKey: e.permissionKey } : {})
                };
                if (e.callId !== undefined) {
                    const tool = findTool(t, e.callId);
                    if (tool) tool.requestId = e.requestId;
                }
                break;
            }
            case 'request-resolved': {
                const open = t.requests[e.requestId];
                delete t.requests[e.requestId];
                if (open?.callId !== undefined) {
                    const tool = findTool(t, open.callId);
                    if (tool && tool.requestId === e.requestId) delete tool.requestId;
                }
                if (e.outcome === 'allow' && e.scope === 'session') {
                    const key = e.permissionKey ?? open?.permissionKey;
                    if (key !== undefined && !t.grants.includes(key)) t.grants.push(key);
                }
                break;
            }
            case 'config':
                t.config = [...e.options];
                break;
            case 'usage':
                if (e.scope === 'session') {
                    t.usage = e.usage;
                    if (e.costUsd !== undefined) t.costUsd = e.costUsd;
                } else {
                    t.usage = addUsage(t.usage, e.usage);
                    if (e.costUsd !== undefined) t.costUsd = (t.costUsd ?? 0) + e.costUsd;
                }
                break;
            case 'state':
                t.state = e.value;
                break;
            case 'error':
                t.error = { code: e.code, message: e.message, recoverable: e.recoverable };
                break;
            case 'ext':
                extensions.get(e.ns)?.reduce(t, e);
                break;
        }
        return t;
    };
}

/** The default reducer — no extensions. */
export const reduceAgentEvent: AgentReducer = createReducer();

function assistantMessage(t: AgentTranscript, id: string, e: AgentEvent): AgentMessage {
    for (let i = t.messages.length - 1; i >= 0; i--) {
        const m = t.messages[i]!;
        if (m.id === id) return m;
    }
    const actor = 'actor' in e && typeof e.actor === 'string' ? e.actor : undefined;
    const message: AgentMessage = {
        id,
        role: 'assistant',
        ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(e.parentCallId !== undefined ? { parentCallId: e.parentCallId } : {}),
        parts: []
    };
    t.messages.push(message);
    return message;
}

/** The turn's latest assistant message at this nesting level, or a new `a:<turnId>:<n>`. */
function currentAssistant(t: AgentTranscript, e: AgentEvent): AgentMessage {
    let count = 0;
    for (let i = t.messages.length - 1; i >= 0; i--) {
        const m = t.messages[i]!;
        if (m.role !== 'assistant' || m.turnId !== e.turnId) continue;
        if (m.parentCallId === e.parentCallId) return m;
        count++;
    }
    return assistantMessage(t, `a:${e.turnId ?? ''}:${count}`, e);
}

function findPart(t: AgentTranscript, partId: string) {
    for (let i = t.messages.length - 1; i >= 0; i--) {
        const parts = t.messages[i]!.parts;
        for (let j = parts.length - 1; j >= 0; j--) {
            const p = parts[j]!;
            if ((p.type === 'text' || p.type === 'reasoning') && p.id === partId) return p;
        }
    }
    return undefined;
}

function findTool(t: AgentTranscript, callId: string): ToolPartState | undefined {
    for (let i = t.messages.length - 1; i >= 0; i--) {
        const parts = t.messages[i]!.parts;
        for (let j = parts.length - 1; j >= 0; j--) {
            const p = parts[j]!;
            if (p.type === 'tool' && p.callId === callId) return p;
        }
    }
    return undefined;
}
