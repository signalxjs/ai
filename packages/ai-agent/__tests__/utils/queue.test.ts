import { describe, it, expect } from 'vitest';
import { createQueue } from '../../src/utils/queue';
import { collect } from '../helpers';

describe('createQueue', () => {
    it('delivers pushed items in order and completes on end()', async () => {
        const q = createQueue<number>();
        q.push(1);
        q.push(2);
        const p = collect(q);
        q.push(3);
        q.end();
        expect(await p).toEqual([1, 2, 3]);
    });

    it('wakes a waiting consumer', async () => {
        const q = createQueue<string>();
        const it = q[Symbol.asyncIterator]();
        const next = it.next();
        q.push('a');
        expect(await next).toEqual({ value: 'a', done: false });
    });

    it('fail() rejects the consumer and drops what is buffered', async () => {
        const q = createQueue<number>();
        q.push(1);
        q.fail(new Error('boom'));
        await expect(collect(q)).rejects.toThrow('boom');
        expect(q.push(2)).toBe(false);
    });

    it('overflow past maxSize fails the queue', async () => {
        const q = createQueue<number>({ maxSize: 2 });
        q.push(1);
        q.push(2);
        expect(q.push(3)).toBe(false);
        await expect(collect(q)).rejects.toThrow(/overflow/);
    });

    it('return() stops early and reports close once', async () => {
        let closes = 0;
        const q = createQueue<number>({ onClose: () => closes++ });
        q.push(1);
        q.push(2);
        for await (const x of q) {
            expect(x).toBe(1);
            break;
        }
        expect(q.size).toBe(0);
        expect(q.push(3)).toBe(false);
        q.end();
        expect(closes).toBe(1);
    });

    it('reports close after a drained end()', async () => {
        let closes = 0;
        const q = createQueue<number>({ onClose: () => closes++ });
        q.push(1);
        q.end();
        expect(closes).toBe(0);
        expect(await collect(q)).toEqual([1]);
        expect(closes).toBe(1);
    });
});
