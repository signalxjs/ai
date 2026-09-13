/**
 * `coalesceFrames` — merge runs of `part-delta` frames for one part into a
 * single frame (`seqFrom..seq`), to spend fewer messages on a chatty model.
 * Off by default; the reducer only appends deltas, so a coalesced stream
 * reduces to the same transcript as the original.
 */

import type { WireFrame } from './envelope.js';

export interface CoalesceOptions {
    /** How long a delta may wait for a successor. Default 16. */
    readonly maxDelayMs?: number;
    /** Flush once the merged delta reaches this many characters. Default 4096. */
    readonly maxBytes?: number;
    /** Timer hook — tests inject a deterministic one. Returns a handle for `cancel`. */
    readonly schedule?: (fn: () => void, ms: number) => unknown;
    /** Cancels a timer `schedule` returned; default `clearTimeout`. */
    readonly cancel?: (handle: unknown) => void;
}

type EventFrame = Extract<WireFrame, { kind: 'event' }>;
type DeltaEvent = Extract<EventFrame['event'], { type: 'part-delta' }>;

export async function* coalesceFrames(frames: AsyncIterable<WireFrame>, options: CoalesceOptions = {}): AsyncGenerator<WireFrame, void, undefined> {
    const maxDelayMs = options.maxDelayMs ?? 16;
    const maxBytes = options.maxBytes ?? 4096;
    const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    let pending: { frame: EventFrame; event: DeltaEvent; seqFrom: number; delta: string } | undefined;
    const flush = (): WireFrame | undefined => {
        if (!pending) return undefined;
        const { frame, event, seqFrom, delta } = pending;
        pending = undefined;
        if (seqFrom === frame.seq) return frame;
        return { ...frame, seqFrom, event: { ...event, delta } };
    };

    const iterator = frames[Symbol.asyncIterator]();
    try {
        for (;;) {
            let timedOut = false;
            let timer: unknown;
            const next = pending
                ? await Promise.race([
                      iterator.next(),
                      new Promise<'timeout'>((resolve) => {
                          timer = schedule(() => {
                              timedOut = true;
                              resolve('timeout');
                          }, maxDelayMs);
                      })
                  ])
                : await iterator.next();
            // The next frame won the race: its timer would only wake the loop for nothing.
            if (!timedOut && timer !== undefined) cancel(timer);
            if (next === 'timeout' || timedOut) {
                const flushed = flush();
                if (flushed) yield flushed;
                if (next !== 'timeout') {
                    // The iterator also produced a value; handle it below.
                } else continue;
            }
            const result = next as IteratorResult<WireFrame>;
            if (result.done) {
                const flushed = flush();
                if (flushed) yield flushed;
                return;
            }
            const frame = result.value;
            if (frame.kind === 'event' && frame.event.type === 'part-delta' && frame.event.parentCallId === undefined) {
                const event = frame.event;
                if (pending && pending.event.partId === event.partId && pending.frame.epoch === frame.epoch && pending.frame.seq + 1 === frame.seq) {
                    pending = { frame, event, seqFrom: pending.seqFrom, delta: pending.delta + event.delta };
                    if (pending.delta.length >= maxBytes) {
                        const flushed = flush();
                        if (flushed) yield flushed;
                    }
                    continue;
                }
                const flushed = flush();
                if (flushed) yield flushed;
                pending = { frame, event, seqFrom: frame.seq, delta: event.delta };
                continue;
            }
            const flushed = flush();
            if (flushed) yield flushed;
            yield frame;
        }
    } finally {
        await iterator.return?.();
    }
}
