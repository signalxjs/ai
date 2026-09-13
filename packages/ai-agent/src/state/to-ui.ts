/**
 * `toUIMessages` — the bridge to `@sigx/ai`'s transcript, so anything that
 * renders `UIMessage`s (the chat example, `useChat`-based components,
 * `toModelMessages`) renders an agent transcript too.
 *
 * Lossy, on purpose and documented: tool statuses collapse onto
 * `UIToolState` (`pending | in_progress` → `pending`, an open permission
 * request → `awaiting`, `completed` → `done`, `failed | cancelled` → `error`,
 * `denied` → `denied`); nested (subagent) assistant messages are flattened
 * into the parent message as a marked text part; extension state is not
 * carried.
 */

import type { UIMessage, UIPart, UIToolState } from '@sigx/ai';
import type { ContentBlock } from '../protocol/index.js';
import type { AgentMessage, AgentTranscript, ToolPartState } from './transcript.js';

export function toUIMessages(transcript: AgentTranscript): UIMessage[] {
    const out: UIMessage[] = [];
    const parentOfCall = new Map<string, UIMessage>();

    for (const m of transcript.messages) {
        if (m.parentCallId !== undefined) {
            // A subagent's message: fold its text into the message that made the call.
            const parent = parentOfCall.get(m.parentCallId);
            const text = m.parts
                .filter((p) => p.type === 'text')
                .map((p) => (p as { text: string }).text)
                .join('');
            if (parent && text) parent.parts.push({ type: 'text', text: `[${m.actor ?? 'subagent'} ${m.parentCallId}] ${text}` });
            continue;
        }
        const ui: UIMessage = { id: m.id, role: m.role, parts: m.role === 'user' ? userParts(m) : assistantParts(m) };
        out.push(ui);
        for (const p of m.parts) if (p.type === 'tool') parentOfCall.set(p.callId, ui);
    }
    return out;
}

function userParts(m: AgentMessage): UIPart[] {
    const parts: UIPart[] = [];
    for (const p of m.parts) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        // Image and file parts share their shape with `UIImagePart` / `UIFilePart`
        // (signalxjs/ai#36); a `resource` has no UI counterpart and is rendered as text.
        else if (p.type === 'image' || p.type === 'file') parts.push({ ...p } as unknown as UIPart);
        else if (p.type === 'resource') parts.push({ type: 'text', text: p.text ?? p.uri });
    }
    return parts;
}

function assistantParts(m: AgentMessage): UIPart[] {
    const parts: UIPart[] = [];
    for (const p of m.parts) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'reasoning') parts.push({ type: 'reasoning', text: p.text, ...(p.providerData !== undefined ? { providerData: p.providerData } : {}) });
        else if (p.type === 'tool') {
            const output = toolOutput(p);
            parts.push({
                type: 'tool',
                id: p.callId,
                name: p.name,
                input: p.input ?? null,
                state: toolState(p),
                ...(output !== undefined ? { output } : {})
            });
        }
    }
    return parts;
}

/** `UIToolState` from a tool part's status (and its open request). */
export function toolState(p: ToolPartState): UIToolState {
    switch (p.status) {
        case 'pending':
        case 'in_progress':
            return p.requestId !== undefined ? 'awaiting' : 'pending';
        case 'completed':
            return 'done';
        case 'denied':
            return 'denied';
        case 'failed':
        case 'cancelled':
            return 'error';
    }
}

/** A tool's output for the UI: `output`, else its content blocks, else the error. */
export function toolOutput(p: ToolPartState): unknown {
    if (p.output !== undefined) return p.output;
    if (p.content?.length) return contentToOutput(p.content);
    if (p.error !== undefined) return p.error;
    return undefined;
}

export function contentToOutput(content: readonly ContentBlock[]): unknown {
    if (content.length === 1) {
        const only = content[0]!;
        if (only.type === 'json') return only.value;
        if (only.type === 'text') return only.text;
    }
    const texts = content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
    if (texts.length === content.length) return texts.join('\n');
    return content.map((c) => (c.type === 'json' ? c.value : c.type === 'text' ? c.text : c));
}
