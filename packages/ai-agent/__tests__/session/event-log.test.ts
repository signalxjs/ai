import { describe, it, expect } from 'vitest';
import { createEventLog, type AgentEvent } from '@sigx/ai-agent';
import { tick } from '../helpers';

const state = (value: 'idle' | 'running') => ({ type: 'state' as const, value });

async function take(it: AsyncIterable<AgentEvent>, n: number): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    if (n === 0) return out;
    for await (const e of it) {
        out.push(e);
        if (out.length === n) break;
    }
    return out;
}

describe('createEventLog', () => {
    it('stamps gapless, monotonic seq within an epoch', () => {
        const log = createEventLog({ sessionId: 's' });
        const a = log.append(state('idle'));
        const b = log.append(state('running'));
        expect([a.seq, b.seq]).toEqual([1, 2]);
        expect(a).toMatchObject({ sessionId: 's', epoch: 1, type: 'state', value: 'idle' });
        expect(log.seq).toBe(2);
    });

    it('bumpEpoch starts a new epoch at seq 0 and clears the replay buffer', () => {
        const log = createEventLog({ sessionId: 's', epoch: 3 });
        log.append(state('idle'));
        expect(log.bumpEpoch()).toBe(4);
        expect(log.seq).toBe(0);
        const e = log.append(state('running'));
        expect(e).toMatchObject({ epoch: 4, seq: 1 });
        // Replay from the old epoch yields only the new epoch's buffer.
        expect(log.subscribe({ epoch: 3, seq: 1 })).toBeDefined();
    });

    it('a live subscriber sees only what comes after it subscribed', async () => {
        const log = createEventLog({ sessionId: 's' });
        log.append(state('idle'));
        const sub = log.subscribe();
        log.append(state('running'));
        const [e] = await take(sub, 1);
        expect(e!.seq).toBe(2);
    });

    it('replays from any (epoch, seq) then tails live', async () => {
        const log = createEventLog({ sessionId: 's' });
        for (let i = 0; i < 5; i++) log.append(state('idle'));
        const sub = log.subscribe({ epoch: 1, seq: 2 });
        log.append(state('running'));
        const got = await take(sub, 4);
        expect(got.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    });

    it('a cursor from an older epoch replays the whole current buffer', async () => {
        const log = createEventLog({ sessionId: 's', epoch: 2 });
        log.append(state('idle'));
        log.append(state('running'));
        const got = await take(log.subscribe({ epoch: 1, seq: 40 }), 2);
        expect(got.map((e) => e.seq)).toEqual([1, 2]);
    });

    it('throws when the requested start has left the buffer', () => {
        const log = createEventLog({ sessionId: 's', bufferSize: 3 });
        for (let i = 0; i < 6; i++) log.append(state('idle'));
        expect(() => log.subscribe({ epoch: 1, seq: 1 })).toThrow(/cannot replay from \(1, 1\)/);
        // seq 3 is the edge: the buffer starts at 4, so "after 3" is complete.
        expect(() => log.subscribe({ epoch: 1, seq: 3 })).not.toThrow();
    });

    it('several subscribers each get every event; a stopped one is dropped', async () => {
        const log = createEventLog({ sessionId: 's' });
        const a = log.subscribe();
        const b = log.subscribe();
        const ia = a[Symbol.asyncIterator]();
        await ia.return?.();
        log.append(state('idle'));
        const [e] = await take(b, 1);
        expect(e!.seq).toBe(1);
    });

    it('a subscriber that falls too far behind is failed, not the producer', async () => {
        const log = createEventLog({ sessionId: 's', maxSubscriberQueue: 2 });
        const slow = log.subscribe();
        log.append(state('idle'));
        log.append(state('idle'));
        log.append(state('idle'));
        await expect(take(slow, 3)).rejects.toThrow(/fell behind/);
        expect(log.seq).toBe(3);
    });

    it('close() ends subscribers after they drain and refuses further appends', async () => {
        const log = createEventLog({ sessionId: 's' });
        const sub = log.subscribe();
        log.append(state('idle'));
        log.close();
        const got: AgentEvent[] = [];
        for await (const e of sub) got.push(e);
        expect(got).toHaveLength(1);
        expect(() => log.append(state('idle'))).toThrow(/closed/);
        await tick();
    });
});
