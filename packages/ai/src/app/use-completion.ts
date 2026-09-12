/**
 * `useCompletion` — one model answer for a page, SSR-first.
 *
 * The text rides core's `useStream`, so it inherits its whole contract:
 * during streaming SSR the tokens append into the initial HTML response as
 * they arrive; on hydration the final text is restored from the state blob
 * and the source is NOT re-run (no second model call); on client
 * navigation it streams live. `key` must be unique per request, as for
 * `useStream`.
 *
 * Reasoning and completion status are client-side extras: they update
 * while the source streams live, and a restored (hydrated) completion
 * reads as finished.
 */

import { signal } from '@sigx/reactivity';
import { useStream } from '@sigx/runtime-core';
import type { UIChunk } from '../protocol/index.js';

export type CompletionStatus = 'streaming' | 'done' | 'error';

export interface Completion {
    /** The answer so far — reactive. */
    readonly text: string;
    /** Reasoning deltas, when the model streams them (live client only). */
    readonly reasoning: string;
    readonly status: CompletionStatus;
    readonly error: Error | null;
}

export function useCompletion(key: string, source: () => AsyncIterable<UIChunk | string>): Completion {
    const meta = signal({ reasoning: '', status: 'done' as CompletionStatus, error: null as Error | null });
    let started = false;

    const text = useStream(key, () => {
        started = true;
        meta.status = 'streaming';
        return textDeltas(source(), meta);
    });

    return {
        get text() {
            return text.value;
        },
        get reasoning() {
            return meta.reasoning;
        },
        get status() {
            // Never started on this client (hydrated, or SSR) ⇒ the text is final.
            return started ? meta.status : 'done';
        },
        get error() {
            return meta.error;
        }
    };
}

async function* textDeltas(
    chunks: AsyncIterable<UIChunk | string>,
    meta: { reasoning: string; status: CompletionStatus; error: Error | null }
): AsyncGenerator<string> {
    try {
        for await (const chunk of chunks) {
            if (typeof chunk === 'string') {
                yield chunk;
                continue;
            }
            switch (chunk.type) {
                case 'text':
                    yield chunk.delta;
                    break;
                case 'reasoning':
                    meta.reasoning += chunk.delta;
                    break;
                case 'error':
                    throw new Error(chunk.message);
                default:
                    break;
            }
        }
        meta.status = 'done';
    } catch (e) {
        // Normalize once and rethrow the same Error, so `completion.error`
        // and what the consumer catches are one and the same object.
        const err = e instanceof Error ? e : new Error(String(e));
        meta.error = err;
        meta.status = 'error';
        throw err;
    }
}
