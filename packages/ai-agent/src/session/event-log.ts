/**
 * The session log — the single place events get their `(epoch, seq)`.
 *
 * `append` is synchronous, so two producers (a mapped model stream and a
 * tool handler emitting a `request`) can never interleave inside a stamp:
 * order is call order, and `seq` is gapless. Subscribers each own a queue;
 * a slow one is failed and dropped rather than stalling the turn.
 */

import { AgentError } from '../protocol/index.js';
import type { AgentEvent, UnstampedEvent } from '../protocol/index.js';
import { createQueue, type AsyncQueue } from '../utils/queue.js';
import type { EventCursor } from './agent.js';

export interface SessionLog {
    readonly sessionId: string;
    readonly epoch: number;
    /** The last `seq` handed out in this epoch (0 before the first event). */
    readonly seq: number;
    readonly closed: boolean;
    /** Stamp, buffer, fan out; returns the stamped event. */
    append(event: UnstampedEvent): AgentEvent;
    /**
     * Events after `from` (exclusive), replayed from the buffer, then live.
     * Without `from`: live only. Throws `AgentError('protocol_error')` when
     * `from` is older than the buffer keeps.
     */
    subscribe(from?: EventCursor): AsyncIterable<AgentEvent>;
    /** Start a new epoch (a resumed session); the replay buffer is cleared. */
    bumpEpoch(): number;
    /** End every subscriber once it has drained. */
    close(): void;
}

export interface EventLogOptions {
    readonly sessionId: string;
    /** First epoch; a resumed session passes `previous + 1`. Default 1. */
    readonly epoch?: number;
    /** Events kept for replay. Default 2000. */
    readonly bufferSize?: number;
    /** Buffered-but-unread events a subscriber may hold before it is dropped. Default 10 000. */
    readonly maxSubscriberQueue?: number;
}

export function createEventLog(options: EventLogOptions): SessionLog {
    const bufferSize = options.bufferSize ?? 2000;
    const maxQueue = options.maxSubscriberQueue ?? 10_000;
    let epoch = options.epoch ?? 1;
    let seq = 0;
    let closed = false;
    const buffer: AgentEvent[] = [];
    const subscribers = new Set<AsyncQueue<AgentEvent>>();

    const log: SessionLog = {
        sessionId: options.sessionId,
        get epoch() {
            return epoch;
        },
        get seq() {
            return seq;
        },
        get closed() {
            return closed;
        },
        append(event) {
            if (closed) throw new AgentError('protocol_error', `[sigx ai-agent] session "${options.sessionId}" is closed; cannot append "${event.type}"`);
            const stamped: AgentEvent = { ...event, sessionId: options.sessionId, epoch, seq: ++seq };
            buffer.push(stamped);
            if (buffer.length > bufferSize) buffer.shift();
            for (const q of subscribers) {
                q.push(stamped);
                if (q.size > maxQueue) {
                    subscribers.delete(q);
                    q.fail(new AgentError('protocol_error', `[sigx ai-agent] subscriber fell behind by more than ${maxQueue} events and was dropped`));
                }
            }
            return stamped;
        },
        subscribe(from) {
            let replay: AgentEvent[] = [];
            if (from) {
                if (from.epoch < epoch) {
                    replay = [...buffer];
                } else if (from.epoch === epoch) {
                    const oldest = buffer[0];
                    if (oldest && oldest.seq > from.seq + 1) {
                        throw new AgentError('protocol_error', `[sigx ai-agent] cannot replay from (${from.epoch}, ${from.seq}): the log now starts at seq ${oldest.seq}`);
                    }
                    replay = buffer.filter((e) => e.seq > from.seq);
                }
                // A cursor from a LATER epoch than ours knows more than we do:
                // treat it as live-only.
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
        bumpEpoch() {
            epoch += 1;
            seq = 0;
            buffer.length = 0;
            return epoch;
        },
        close() {
            if (closed) return;
            closed = true;
            for (const q of subscribers) q.end();
            subscribers.clear();
        }
    };
    return log;
}
