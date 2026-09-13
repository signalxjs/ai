/**
 * Store interfaces — persistence is an app concern; the library names the
 * seams and ships in-memory implementations for tests and single-process use.
 */

import type { AgentEvent } from '../protocol/index.js';
import type { EventCursor } from '../session/index.js';
import type { AgentTranscript } from '../state/index.js';

/** Whole-transcript persistence, keyed by session id (`modelAgent` resume, snapshots). */
export interface TranscriptStore {
    load(sessionId: string): Promise<AgentTranscript | undefined>;
    save(sessionId: string, transcript: AgentTranscript): Promise<void>;
    delete?(sessionId: string): Promise<void>;
}

/** Durable event storage for replay beyond the in-memory buffer (`./wire` late joiners). */
export interface EventLogStore {
    append(event: AgentEvent): Promise<void>;
    /** Events of `sessionId` after `from` (exclusive), in `(epoch, seq)` order. */
    read(sessionId: string, from?: EventCursor): AsyncIterable<AgentEvent>;
}

export function memoryTranscriptStore(): TranscriptStore & { readonly size: number } {
    const map = new Map<string, AgentTranscript>();
    return {
        get size() {
            return map.size;
        },
        async load(id) {
            const t = map.get(id);
            return t ? structuredClone(t) : undefined;
        },
        async save(id, transcript) {
            map.set(id, structuredClone(transcript));
        },
        async delete(id) {
            map.delete(id);
        }
    };
}

export function memoryEventLog(): EventLogStore & { readonly size: number } {
    const bySession = new Map<string, AgentEvent[]>();
    return {
        get size() {
            let n = 0;
            for (const list of bySession.values()) n += list.length;
            return n;
        },
        async append(event) {
            let list = bySession.get(event.sessionId);
            if (!list) bySession.set(event.sessionId, (list = []));
            list.push(event);
        },
        async *read(sessionId, from) {
            const list = bySession.get(sessionId) ?? [];
            for (const e of list) {
                if (from && (e.epoch < from.epoch || (e.epoch === from.epoch && e.seq <= from.seq))) continue;
                yield e;
            }
        }
    };
}
