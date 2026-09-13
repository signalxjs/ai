/**
 * A replay buffer for events that ARRIVE stamped — the client side of the
 * wire. Like the session log it fans out to subscribers and replays from a
 * cursor, but it never stamps: the remote `(epoch, seq)` is the truth.
 * Private to `wire/`.
 */

import { AgentError } from '../protocol/index.js';
import type { AgentEvent } from '../protocol/index.js';
import { createQueue, type AsyncQueue } from '../utils/queue.js';
import { cursorBefore, type Cursor } from './envelope.js';

export interface ReplayBuffer {
    readonly head: Cursor | undefined;
    /** Append a stamped event; returns `false` (and drops it) when it is not after `head`. A coalesced event names its `seqFrom`. */
    push(event: AgentEvent, seqFrom?: number): boolean;
    /**
     * Events after `from` (exclusive) from the buffer, then live; without `from`,
     * live only. Throws when `from` lands inside a coalesced span — the merged
     * delta cannot be split, so a cursor there cannot be honoured exactly.
     */
    subscribe(from?: Cursor): AsyncIterable<AgentEvent>;
    /** Forget everything buffered (a `gap`); live subscribers continue. */
    reset(head: Cursor): void;
    close(): void;
}

export function createReplayBuffer(options: { readonly size?: number; readonly maxSubscriberQueue?: number } = {}): ReplayBuffer {
    const size = options.size ?? 2000;
    const maxQueue = options.maxSubscriberQueue ?? 10_000;
    const buffer: { event: AgentEvent; seqFrom: number }[] = [];
    const subscribers = new Set<AsyncQueue<AgentEvent>>();
    let head: Cursor | undefined;
    let closed = false;

    return {
        get head() {
            return head;
        },
        push(event, seqFrom) {
            if (closed) return false;
            const cursor = { epoch: event.epoch, seq: event.seq };
            if (head && !cursorBefore(head, cursor)) return false;
            if (head && event.epoch > head.epoch) buffer.length = 0; // a new epoch: the old one cannot be replayed into it
            head = cursor;
            buffer.push({ event, seqFrom: seqFrom ?? event.seq });
            if (buffer.length > size) buffer.shift();
            for (const q of subscribers) {
                q.push(event);
                // (the queue only ever holds events; spans matter for replay alone)
                if (q.size > maxQueue) {
                    subscribers.delete(q);
                    q.fail(new AgentError('protocol_error', `[sigx ai-agent] subscriber fell behind by more than ${maxQueue} events and was dropped`));
                }
            }
            return true;
        },
        subscribe(from) {
            let replay: AgentEvent[] = [];
            if (from && head) {
                if (from.epoch < head.epoch) replay = buffer.map((b) => b.event);
                else if (from.epoch === head.epoch) {
                    const oldest = buffer[0];
                    if (oldest && oldest.seqFrom > from.seq + 1) throw new AgentError('protocol_error', `[sigx ai-agent] cannot replay from (${from.epoch}, ${from.seq}): the buffer now starts at seq ${oldest.seqFrom}`);
                    const straddling = buffer.find((b) => b.seqFrom <= from.seq && from.seq < b.event.seq);
                    if (straddling) {
                        throw new AgentError('protocol_error', `[sigx ai-agent] cannot replay from (${from.epoch}, ${from.seq}): it lies inside a coalesced span ${straddling.seqFrom}..${straddling.event.seq}`);
                    }
                    replay = buffer.filter((b) => b.event.seq > from.seq).map((b) => b.event);
                }
            }
            const queue = createQueue<AgentEvent>({
                onClose: () => {
                    subscribers.delete(queue);
                }
            });
            for (const e of replay) queue.push(e);
            if (closed) queue.end();
            else subscribers.add(queue);
            return queue;
        },
        reset(at) {
            buffer.length = 0;
            head = at;
        },
        close() {
            if (closed) return;
            closed = true;
            for (const q of subscribers) q.end();
            subscribers.clear();
        }
    };
}
