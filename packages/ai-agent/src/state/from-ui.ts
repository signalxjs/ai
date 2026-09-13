/**
 * `fromUIMessages` — import a `@sigx/ai` transcript into a session
 * transcript, for agents with the `importTranscript` capability.
 *
 * One code path: the messages are turned into the events that would have
 * produced them (`user-message`, `part-*`, `tool-call`, `tool-update`) and
 * reduced, so `toUIMessages(fromUIMessages(m).transcript)` round-trips by
 * construction, and the events themselves can seed a session log.
 */

import type { UIMessage, UIToolState } from '@sigx/ai';
import type { AgentEvent, PromptPart, ToolStatus, UnstampedEvent } from '../protocol/index.js';
import { createReducer, type AgentReducer } from './reduce.js';
import { createTranscript, type AgentTranscript } from './transcript.js';

export interface FromUIOptions {
    readonly sessionId: string;
    /** Default 1. */
    readonly epoch?: number;
    readonly reducer?: AgentReducer;
}

export interface Imported {
    readonly transcript: AgentTranscript;
    /** The stamped events that were reduced, in order. */
    readonly events: AgentEvent[];
}

export function fromUIMessages(messages: readonly UIMessage[], options: FromUIOptions): Imported {
    const reducer = options.reducer ?? createReducer();
    const epoch = options.epoch ?? 1;
    const transcript = createTranscript(options.sessionId);
    const events: AgentEvent[] = [];
    let seq = 0;
    const emit = (e: UnstampedEvent) => {
        const stamped: AgentEvent = { ...e, sessionId: options.sessionId, epoch, seq: ++seq };
        events.push(stamped);
        reducer(transcript, stamped);
    };

    let turn = 0;
    for (const m of messages) {
        if (m.role === 'user') {
            turn++;
            const turnId = `import:${turn}`;
            emit({ type: 'user-message', turnId, messageId: m.id, parts: m.parts.map(toPromptPart).filter((p): p is PromptPart => p !== undefined) });
            continue;
        }
        const turnId = `import:${turn}`;
        let partSeq = 0;
        for (const p of m.parts) {
            if (p.type === 'text' || p.type === 'reasoning') {
                const partId = `${m.id}:${partSeq++}`;
                emit({ type: 'part-start', turnId, messageId: m.id, partId, kind: p.type });
                if (p.text) emit({ type: 'part-delta', turnId, partId, delta: p.text });
                emit({ type: 'part-end', turnId, partId, ...(p.type === 'reasoning' && p.providerData !== undefined ? { providerData: p.providerData } : {}) });
            } else if (p.type === 'tool') {
                emit({ type: 'tool-call', turnId, messageId: m.id, callId: p.id, name: p.name, input: p.input });
                const status = toolStatus(p.state);
                if (status !== 'pending') {
                    emit({
                        type: 'tool-update',
                        turnId,
                        callId: p.id,
                        status,
                        ...(p.output !== undefined ? (status === 'completed' ? { output: p.output } : { error: typeof p.output === 'string' ? p.output : JSON.stringify(p.output) }) : {})
                    });
                }
            }
        }
    }
    return { transcript, events };
}

function toPromptPart(p: UIMessage['parts'][number]): PromptPart | undefined {
    if (p.type === 'text') return { type: 'text', text: p.text };
    // `image` / `file` parts (signalxjs/ai#36) share the prompt part shape.
    const t = (p as { type: string }).type;
    if (t === 'image' || t === 'file') return { ...(p as object) } as PromptPart;
    return undefined;
}

function toolStatus(state: UIToolState): ToolStatus {
    switch (state as string) {
        case 'done':
            return 'completed';
        case 'error':
            return 'failed';
        case 'denied':
            return 'denied';
        default:
            return 'pending';
    }
}
