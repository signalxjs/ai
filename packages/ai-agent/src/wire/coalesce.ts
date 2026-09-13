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
    /**
     * The pull that is already in flight. An async iterator hands each value to
     * exactly ONE `next()` promise, so when the flush timer wins the race the
     * pull must be kept and awaited again — dropping it drops that frame, and
     * with a model slower than `maxDelayMs` that is every frame after the first.
     */
    let inflight: Promise<IteratorResult<WireFrame>> | undefined;
    try {
        for (;;) {
            let timedOut = false;
            let timer: unknown;
            const pull = (inflight ??= iterator.next());
            let next: IteratorResult<WireFrame> | 'timeout';
            try {
                next = pending
                    ? await Promise.race([
                          pull,
                          new Promise<'timeout'>((resolve) => {
                              timer = schedule(() => {
                                  timedOut = true;
                                  resolve('timeout');
                              }, maxDelayMs);
                          })
                      ])
                    : await pull;
            } catch (e) {
                inflight = undefined;
                throw e;
            } finally {
                // The next frame won the race (or the source failed): the timer would only wake the loop for nothing.
                if (!timedOut && timer !== undefined) cancel(timer);
            }
            if (next === 'timeout') {
                const flushed = flush();
                if (flushed) yield flushed;
                // `inflight` stays armed: the frame it will deliver is still owed to us.
                continue;
            }
            inflight = undefined;
            if (timedOut) {
                // Both settled: flush what was pending before the frame that arrived with it.
                const flushed = flush();
                if (flushed) yield flushed;
            }
            const result = next;
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
