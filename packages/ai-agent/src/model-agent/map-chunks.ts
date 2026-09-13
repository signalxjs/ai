/**
 * `UIChunk` → agent events, for one turn of our own engine. A small state
 * machine: it opens and closes text / reasoning parts around the deltas,
 * turns tool calls and results into `tool-call` / `tool-update`, and ends the
 * turn on `finish` or `error` — exactly one `turn-end`.
 */

import type { AnyTool, FinishReason, UIChunk } from '@sigx/ai';
import type { StopReason } from '../protocol/index.js';
import type { TurnDriver } from '../session/index.js';

export interface ChunkMapper {
    /** Feed the next chunk; the driver receives the events. */
    apply(chunk: UIChunk): void;
}

/** The engine's own message for calls it refused to run at the step limit. */
const STEP_LIMIT = /was not run: step limit/;

export function createChunkMapper(driver: TurnDriver, options: { readonly messageId: string; readonly tools?: readonly AnyTool[] }): ChunkMapper {
    const { messageId } = options;
    let partSeq = 0;
    let open: { partId: string; kind: 'text' | 'reasoning' } | undefined;
    let hitStepLimit = false;
    const byName = new Map((options.tools ?? []).map((t) => [t.name, t] as const));
    /** Calls announced but not yet settled — an aborted turn leaves them behind. */
    const openCalls = new Set<string>();

    /** Every call reaches a terminal status, even when the engine stopped mid-flight. */
    const settleOpenCalls = () => {
        for (const callId of openCalls) {
            driver.emit(
                driver.signal.aborted ? { type: 'tool-update', callId, status: 'cancelled' } : { type: 'tool-update', callId, status: 'failed', error: 'The turn ended before the tool call was settled.' }
            );
        }
        openCalls.clear();
    };

    const closePart = () => {
        if (!open) return;
        driver.emit({ type: 'part-end', partId: open.partId });
        open = undefined;
    };
    const openPart = (kind: 'text' | 'reasoning') => {
        if (open?.kind === kind) return open.partId;
        closePart();
        const partId = `${messageId}:${partSeq++}`;
        open = { partId, kind };
        driver.emit({ type: 'part-start', messageId, partId, kind });
        return partId;
    };

    return {
        apply(chunk) {
            switch (chunk.type) {
                case 'start':
                    break;
                case 'text':
                    driver.emit({ type: 'part-delta', partId: openPart('text'), delta: chunk.delta });
                    break;
                case 'reasoning':
                    driver.emit({ type: 'part-delta', partId: openPart('reasoning'), delta: chunk.delta });
                    break;
                case 'reasoning-end': {
                    if (open?.kind === 'reasoning') {
                        driver.emit({ type: 'part-end', partId: open.partId, ...(chunk.providerData !== undefined ? { providerData: chunk.providerData } : {}) });
                        open = undefined;
                    } else if (chunk.providerData !== undefined) {
                        // Reasoning that arrived as replay data only.
                        const partId = `${messageId}:${partSeq++}`;
                        driver.emit({ type: 'part-start', messageId, partId, kind: 'reasoning' });
                        driver.emit({ type: 'part-end', partId, providerData: chunk.providerData });
                    }
                    break;
                }
                case 'tool-call': {
                    closePart();
                    const tool = byName.get(chunk.name);
                    driver.emit({
                        type: 'tool-call',
                        callId: chunk.id,
                        name: chunk.name,
                        messageId,
                        input: chunk.input,
                        ...(tool?.annotations ? { annotations: tool.annotations } : {})
                    });
                    driver.emit({ type: 'tool-update', callId: chunk.id, status: 'pending' });
                    openCalls.add(chunk.id);
                    break;
                }
                case 'tool-approval-request':
                    // The gate emits the `request` itself when it asks the policy.
                    break;
                case 'tool-result': {
                    openCalls.delete(chunk.id);
                    const text = typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output);
                    if (chunk.denied) driver.emit({ type: 'tool-update', callId: chunk.id, status: 'denied', error: text });
                    else if (chunk.isError) {
                        if (STEP_LIMIT.test(text)) hitStepLimit = true;
                        driver.emit({ type: 'tool-update', callId: chunk.id, status: 'failed', error: text });
                    } else driver.emit({ type: 'tool-update', callId: chunk.id, status: 'completed', output: chunk.output });
                    break;
                }
                case 'finish': {
                    closePart();
                    settleOpenCalls();
                    if (chunk.usage) driver.emit({ type: 'usage', scope: 'turn', usage: chunk.usage });
                    driver.end({
                        stopReason: toStopReason(chunk.reason, hitStepLimit),
                        ...(chunk.usage ? { usage: chunk.usage } : {}),
                        ...(chunk.output !== undefined ? { output: chunk.output } : {})
                    });
                    break;
                }
                case 'error': {
                    closePart();
                    settleOpenCalls();
                    driver.emit({ type: 'error', code: 'provider_error', message: chunk.message, recoverable: false });
                    driver.end({ stopReason: 'error', error: { code: 'provider_error', message: chunk.message } });
                    break;
                }
            }
        }
    };
}

/** `other` is the engine's word for an abort; `createTurn` turns it into `cancelled` when its signal fired. */
export function toStopReason(reason: FinishReason, stepLimit: boolean): StopReason {
    switch (reason) {
        case 'length':
            return stepLimit ? 'max_turns' : 'max_tokens';
        case 'refusal':
            return 'refusal';
        case 'error':
            return 'error';
        default:
            return 'end_turn';
    }
}
