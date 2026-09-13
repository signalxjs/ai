import { describe, it, expect } from 'vitest';
import { createTranscript, reduceAgentEvent, type AgentEvent } from '@sigx/ai-agent';
import { coalesceFrames, serveSession, type WireFrame } from '@sigx/ai-agent/wire';
import { mockAgent } from '@sigx/ai-agent/testing';
import { collect } from '../helpers';

let seq = 0;
const frame = (event: Omit<AgentEvent, 'sessionId' | 'epoch' | 'seq'>): WireFrame => {
    const e = { ...event, sessionId: 's', epoch: 1, seq: ++seq } as AgentEvent;
    return { v: 1, kind: 'event', epoch: 1, seq: e.seq, event: e };
};
const delta = (partId: string, text: string) => frame({ type: 'part-delta', turnId: 't', partId, delta: text } as Omit<AgentEvent, 'sessionId' | 'epoch' | 'seq'>);

async function* from(frames: WireFrame[]) {
    yield* frames;
}

describe('coalesceFrames', () => {
    it('merges runs of deltas for one part into a frame spanning seqFrom..seq, deterministically', async () => {
        seq = 0;
        const never = () => undefined; // a scheduler that never fires: only size and stream end flush
        const frames = [frame({ type: 'part-start', turnId: 't', messageId: 'm', partId: 'p', kind: 'text' } as never), delta('p', 'Hel'), delta('p', 'lo '), delta('p', 'wor'), delta('p', 'ld'), frame({ type: 'part-end', turnId: 't', partId: 'p' } as never)];
        const out = await collect(coalesceFrames(from(frames), { schedule: never }));
        expect(out.map((f) => (f.kind === 'event' ? [f.event.type, f.seqFrom, f.seq] : f.kind))).toEqual([
            ['part-start', undefined, 1],
            ['part-delta', 2, 5],
            ['part-end', undefined, 6]
        ]);
        expect((out[1] as Extract<WireFrame, { kind: 'event' }>).event).toMatchObject({ type: 'part-delta', delta: 'Hello world' });

        // A different part, a nested delta or a size cap breaks the run.
        seq = 0;
        const mixed = [delta('p', 'aa'), delta('p', 'bb'), delta('q', 'cc'), delta('q', 'dd'), frame({ type: 'part-delta', turnId: 't', parentCallId: 'c', partId: 'n', delta: 'x' } as never), delta('q', 'ee')];
        const out2 = await collect(coalesceFrames(from(mixed), { schedule: never, maxBytes: 4 }));
        expect(out2.map((f) => (f.kind === 'event' ? [(f.event as { delta?: string }).delta, f.seqFrom ?? f.seq, f.seq] : f.kind))).toEqual([
            ['aabb', 1, 2],
            ['ccdd', 3, 4],
            ['x', 5, 5],
            ['ee', 6, 6]
        ]);
    });

    it('a timer that lost the race to the next frame is cancelled', async () => {
        seq = 0;
        const scheduled: (() => void)[] = [];
        const cancelled: unknown[] = [];
        const frames = [delta('p', 'a'), delta('p', 'b'), delta('p', 'c'), frame({ type: 'part-end', turnId: 't', partId: 'p' } as never)];
        const out = await collect(coalesceFrames(from(frames), { schedule: (fn) => (scheduled.push(fn), scheduled.length), cancel: (h) => cancelled.push(h) }));
        // Three pending waits, each won by the next frame → three timers armed, three cancelled.
        expect(scheduled).toHaveLength(3);
        expect(cancelled).toEqual([1, 2, 3]);
        expect(out.map((f) => (f.kind === 'event' ? f.event.type : f.kind))).toEqual(['part-delta', 'part-end']);
    });

    it('a timer flushes a lone delta', async () => {
        seq = 0;
        const timers: (() => void)[] = [];
        const frames = from([delta('p', 'a')]);
        // A source that never ends on its own, so only the timer can flush.
        const stuck: AsyncIterable<WireFrame> = {
            async *[Symbol.asyncIterator]() {
                yield* frames;
                await new Promise(() => {});
            }
        };
        const it = coalesceFrames(stuck, { schedule: (fn) => timers.push(fn) })[Symbol.asyncIterator]();
        const first = it.next();
        await new Promise((r) => setTimeout(r, 5));
        expect(timers).toHaveLength(1);
        timers[0]!();
        expect((await first).value).toMatchObject({ kind: 'event', seq: 1 });
        // The source never yields again, so return() could not settle; let it go.
        void it.return?.();
    });

    it('a timer flush never drops the pull that was already in flight (a slow model streams every delta)', async () => {
        seq = 0;
        // A real model pauses between deltas. Every gap here is longer than
        // `maxDelayMs`, so the timer wins EVERY race — the pull racing against
        // it is still owed a frame, and an async iterator delivers each value
        // exactly once. Abandoning it drops the frame for good.
        const frames = [frame({ type: 'part-start', turnId: 't', messageId: 'm', partId: 'p', kind: 'text' } as never), delta('p', 'p'), delta('p', 'on'), delta('p', 'g'), frame({ type: 'part-end', turnId: 't', partId: 'p' } as never)];
        const slow: AsyncIterable<WireFrame> = {
            async *[Symbol.asyncIterator]() {
                for (const f of frames) {
                    await new Promise((r) => setTimeout(r, 12));
                    yield f;
                }
            }
        };
        const out = await collect(coalesceFrames(slow, { maxDelayMs: 1 }));
        expect(out.map((f) => (f.kind === 'event' ? f.event.type : f.kind))).toEqual(['part-start', 'part-delta', 'part-delta', 'part-delta', 'part-end']);
        expect(
            out
                .filter((f): f is Extract<WireFrame, { kind: 'event' }> => f.kind === 'event' && f.event.type === 'part-delta')
                .map((f) => (f.event as { delta: string }).delta)
                .join('')
        ).toBe('pong');
    });

    it('a coalesced stream reduces to the same transcript as the original', async () => {
        const agent = mockAgent({ script: [[{ reasoning: 'thinking hard', text: 'Hello brave new world, this is a longer reply.' }, { tool: { name: 't', output: 1 } }, { text: 'Bye now.' }]] });
        const session = await agent.session({ policy: (r) => (r.kind === 'permission' ? { type: 'permission', outcome: 'allow', scope: 'once' } : 'ask') });
        const served = serveSession(session, { agentId: 'mock', capabilities: agent.capabilities });
        const coalesced = serveSession(session, { agentId: 'mock', capabilities: agent.capabilities, coalesce: { schedule: () => undefined } });
        await session.prompt('go').result;
        await session.close();
        const plain = (await collect(served.events({ epoch: 0, seq: 0 }))).filter((f): f is Extract<WireFrame, { kind: 'event' }> => f.kind === 'event');
        const merged = (await collect(coalesced.events({ epoch: 0, seq: 0 }))).filter((f): f is Extract<WireFrame, { kind: 'event' }> => f.kind === 'event');
        expect(merged.length).toBeLessThan(plain.length);
        expect(merged.filter((f) => f.seqFrom !== undefined).length).toBeGreaterThan(0);
        const a = createTranscript(session.id);
        const b = createTranscript(session.id);
        for (const f of plain) reduceAgentEvent(a, f.event);
        for (const f of merged) reduceAgentEvent(b, f.event);
        expect(b).toEqual(a);
    });
});
