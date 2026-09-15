/**
 * `toChatStream` — render a turn through plain `useChat`.
 *
 * A read-only bridge from agent events to `UIChunk`s: one `start`, text and
 * reasoning deltas, tool calls and results, exactly one terminal chunk
 * (`finish`, or `error` when the turn ended in error). A permission request
 * becomes a `tool-approval-request` chunk so the UI can show the wait;
 * answering it still goes through `session.respond()`. Nested (subagent)
 * events are skipped — `useChat` has no place for them.
 */

import type { FinishReason, UIChunk } from '@sigx/ai';
import type { AgentEvent, StopReason } from '../protocol/index.js';
import { contentToOutput } from './to-ui.js';

export async function* toChatStream(events: AsyncIterable<AgentEvent>): AsyncGenerator<UIChunk, void, undefined> {
    const kinds = new Map<string, 'text' | 'reasoning'>();
    let started = false;
    for await (const e of events) {
        if (e.parentCallId !== undefined) continue;
        switch (e.type) {
            case 'turn-start':
                if (!started) {
                    started = true;
                    yield { type: 'start', messageId: `a:${e.turnId ?? ''}:0` };
                }
                break;
            case 'part-start':
                kinds.set(e.partId, e.kind);
                break;
            case 'part-delta':
                yield kinds.get(e.partId) === 'reasoning' ? { type: 'reasoning', delta: e.delta } : { type: 'text', delta: e.delta };
                break;
            case 'part-end':
                if (kinds.get(e.partId) === 'reasoning') yield e.providerData !== undefined ? { type: 'reasoning-end', providerData: e.providerData } : { type: 'reasoning-end' };
                break;
            case 'tool-input-delta':
                yield { type: 'tool-input', id: e.callId, name: e.name, delta: e.delta };
                break;
            case 'tool-call':
                yield { type: 'tool-call', id: e.callId, name: e.name, input: e.input ?? null };
                break;
            case 'tool-update':
                if (e.status === 'completed') yield { type: 'tool-result', id: e.callId, output: e.output ?? (e.content ? contentToOutput(e.content) : null) };
                else if (e.status === 'denied') yield { type: 'tool-result', id: e.callId, output: e.error ?? 'Denied.', isError: true, denied: true };
                else if (e.status === 'failed' || e.status === 'cancelled') yield { type: 'tool-result', id: e.callId, output: e.error ?? (e.status === 'cancelled' ? 'Cancelled.' : 'Failed.'), isError: true };
                break;
            case 'request':
                // The UI shows the wait; answering still goes through `session.respond()`.
                if (e.kind === 'permission' && e.callId !== undefined) yield { type: 'tool-approval-request', id: e.callId };
                break;
            case 'turn-end':
                if (e.stopReason === 'error') {
                    yield { type: 'error', message: e.error?.message ?? 'The turn failed.' };
                } else {
                    yield { type: 'finish', reason: toFinishReason(e.stopReason), ...(e.usage !== undefined ? { usage: e.usage } : {}) };
                }
                return;
        }
    }
}

export function toFinishReason(stop: StopReason): FinishReason {
    switch (stop) {
        case 'end_turn':
            return 'stop';
        case 'max_tokens':
        case 'max_turns':
            return 'length';
        case 'refusal':
            return 'refusal';
        case 'cancelled':
            return 'other';
        case 'error':
            return 'error';
    }
}
