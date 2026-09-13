import { describe, it, expect } from 'vitest';
import { memoryTranscriptStore, memoryEventLog, createTranscript, type AgentEvent } from '@sigx/ai-agent';
import { collect } from '../helpers';

describe('memoryTranscriptStore', () => {
    it('saves and loads copies, not references', async () => {
        const store = memoryTranscriptStore();
        const t = createTranscript('s');
        t.grants.push('a');
        await store.save('s', t);
        t.grants.push('b');
        const loaded = await store.load('s');
        expect(loaded?.grants).toEqual(['a']);
        loaded!.grants.push('c');
        expect((await store.load('s'))?.grants).toEqual(['a']);
        expect(await store.load('missing')).toBeUndefined();
        await store.delete!('s');
        expect(store.size).toBe(0);
    });
});

describe('memoryEventLog', () => {
    const e = (sessionId: string, epoch: number, seq: number): AgentEvent => ({ type: 'state', value: 'idle', sessionId, epoch, seq });

    it('reads a session’s events after a cursor, across epochs', async () => {
        const log = memoryEventLog();
        for (const ev of [e('a', 1, 1), e('a', 1, 2), e('b', 1, 1), e('a', 2, 1), e('a', 2, 2)]) await log.append(ev);
        expect(log.size).toBe(5);
        expect((await collect(log.read('a'))).map((x) => `${x.epoch}:${x.seq}`)).toEqual(['1:1', '1:2', '2:1', '2:2']);
        expect((await collect(log.read('a', { epoch: 1, seq: 2 }))).map((x) => `${x.epoch}:${x.seq}`)).toEqual(['2:1', '2:2']);
        expect((await collect(log.read('a', { epoch: 2, seq: 1 }))).map((x) => `${x.epoch}:${x.seq}`)).toEqual(['2:2']);
        expect(await collect(log.read('c'))).toEqual([]);
    });
});
