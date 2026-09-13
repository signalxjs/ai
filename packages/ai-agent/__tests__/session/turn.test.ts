import { describe, it, expect } from 'vitest';
import { createEventLog, createTurn, failedTurn, SessionBusyError, AgentError, type TurnDriver } from '@sigx/ai-agent';
import { collect, drain, types, tick } from '../helpers';

const input = [{ type: 'text' as const, text: 'hi' }];

describe('createTurn', () => {
    it('emits turn-start first, stamps every event with the turnId, resolves result from turn-end', async () => {
        const log = createEventLog({ sessionId: 's' });
        const turn = createTurn({
            log,
            input,
            turnId: 't1',
            run: async (d) => {
                d.emit({ type: 'part-start', messageId: 'm', partId: 'p', kind: 'text' });
                d.emit({ type: 'part-delta', partId: 'p', delta: 'hello' });
                d.end({ stopReason: 'end_turn', usage: { outputTokens: 1 } });
            }
        });
        expect(turn.id).toBe('t1');
        const { events, result } = await drain(turn);
        expect(types(events)).toEqual(['turn-start', 'part-start', 'part-delta', 'turn-end']);
        expect(events.every((e) => e.turnId === 't1')).toBe(true);
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
        expect(result).toEqual({ turnId: 't1', stopReason: 'end_turn', usage: { outputTokens: 1 } });
        expect(events[3]).toMatchObject({ type: 'turn-end', stopReason: 'end_turn', usage: { outputTokens: 1 } });
    });

    it('awaiting result without iterating never deadlocks', async () => {
        const log = createEventLog({ sessionId: 's' });
        const turn = createTurn({
            log,
            input,
            run: async (d) => {
                for (let i = 0; i < 50; i++) d.emit({ type: 'part-delta', partId: 'p', delta: 'x' });
                d.end({ stopReason: 'end_turn' });
            }
        });
        const result = await turn.result;
        expect(result.stopReason).toBe('end_turn');
        // The buffer is still there for a late iterator.
        const events = await collect(turn);
        expect(events).toHaveLength(52);
    });

    it('a second iteration replays from the log', async () => {
        const log = createEventLog({ sessionId: 's' });
        log.append({ type: 'state', value: 'idle' });
        const turn = createTurn({
            log,
            input,
            run: async (d) => {
                d.emit({ type: 'part-delta', partId: 'p', delta: 'a' });
                d.end({ stopReason: 'end_turn' });
            }
        });
        const first = await collect(turn);
        const second = await collect(turn);
        expect(second).toEqual(first);
        expect(types(second)).toEqual(['turn-start', 'part-delta', 'turn-end']);
    });

    it('cancel() aborts the driver signal and the turn ends cancelled', async () => {
        const log = createEventLog({ sessionId: 's' });
        const turn = createTurn({
            log,
            input,
            run: async (d) => {
                await new Promise<void>((resolve) => d.signal.addEventListener('abort', () => resolve(), { once: true }));
                d.end({ stopReason: 'end_turn' });
            }
        });
        await tick();
        turn.cancel();
        const { result, events } = await drain(turn);
        expect(result.stopReason).toBe('cancelled');
        expect(events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'cancelled' });
    });

    it('a run that throws ends with an error event and stopReason error', async () => {
        const log = createEventLog({ sessionId: 's' });
        const turn = createTurn({
            log,
            input,
            run: async () => {
                throw new AgentError('rate_limited', 'slow down', true);
            }
        });
        const { events, result } = await drain(turn);
        expect(types(events)).toEqual(['turn-start', 'error', 'turn-end']);
        expect(events[1]).toMatchObject({ type: 'error', code: 'rate_limited', recoverable: true });
        expect(result).toMatchObject({ stopReason: 'error', error: { code: 'rate_limited', message: 'slow down' } });
    });

    it('a run that returns without end() is a protocol error, not a hang', async () => {
        const log = createEventLog({ sessionId: 's' });
        const turn = createTurn({ log, input, run: async () => {} });
        const { events, result } = await drain(turn);
        expect(result).toMatchObject({ stopReason: 'error', error: { code: 'protocol_error' } });
        expect(types(events)).toEqual(['turn-start', 'error', 'turn-end']);
    });

    it('a run that returns after an abort ends cancelled', async () => {
        const log = createEventLog({ sessionId: 's' });
        const ctrl = new AbortController();
        const turn = createTurn({
            log,
            input,
            signals: [ctrl.signal],
            run: async (d) => {
                ctrl.abort();
                expect(d.signal.aborted).toBe(true);
            }
        });
        expect((await turn.result).stopReason).toBe('cancelled');
    });

    it('events after end() are dropped and nesting adds parentCallId', async () => {
        const log = createEventLog({ sessionId: 's' });
        let driver!: TurnDriver;
        const turn = createTurn({
            log,
            input,
            parentCallId: 'call_9',
            run: async (d) => {
                driver = d;
                d.end({ stopReason: 'end_turn' });
            }
        });
        const { events } = await drain(turn);
        expect(events.every((e) => e.parentCallId === 'call_9')).toBe(true);
        expect(driver.ended).toBe(true);
        const dropped = driver.emit({ type: 'part-delta', partId: 'p', delta: 'late' });
        expect(dropped.seq).toBe(-1);
        expect(log.seq).toBe(2);
    });

    it('failedTurn rejects result and throws on iteration', async () => {
        const turn = failedTurn('t9', new SessionBusyError('s', 't1'));
        await expect(turn.result).rejects.toBeInstanceOf(SessionBusyError);
        await expect(collect(turn)).rejects.toBeInstanceOf(SessionBusyError);
    });
});
