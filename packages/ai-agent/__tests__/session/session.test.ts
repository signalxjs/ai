import { describe, it, expect } from 'vitest';
import { createEventLog, createSessionCore, SessionBusyError, allowAll, type AgentEvent } from '@sigx/ai-agent';
import { collect, drain, types, tick } from '../helpers';

function core(extra: Partial<Parameters<typeof createSessionCore>[0]> = {}) {
    const log = createEventLog({ sessionId: 's' });
    return { log, core: createSessionCore({ id: 's', log, ...extra }) };
}

describe('createSessionCore', () => {
    it('runs a turn with state events around it', async () => {
        const { core: c, log } = core();
        const all = collect(log.subscribe());
        const turn = c.startTurn('hi', undefined, async (d) => d.end({ stopReason: 'end_turn' }));
        expect(c.state).toBe('running');
        await turn.result;
        expect(c.state).toBe('idle');
        expect(c.current).toBeNull();
        await c.close();
        const events = await all;
        expect(types(events)).toEqual(['turn-start', 'state', 'turn-end', 'state', 'state']);
        expect(events.filter((e) => e.type === 'state').map((e) => (e as Extract<AgentEvent, { type: 'state' }>).value)).toEqual(['running', 'idle', 'closed']);
    });

    it('a prompt while a turn runs yields a turn whose result rejects with SessionBusyError', async () => {
        const { core: c } = core();
        let release!: () => void;
        const first = c.startTurn('a', undefined, async (d) => {
            await new Promise<void>((r) => (release = r));
            d.end({ stopReason: 'end_turn' });
        });
        const second = c.startTurn('b', { turnId: 'busy' }, async (d) => d.end({ stopReason: 'end_turn' }));
        expect(second.id).toBe('busy');
        await expect(second.result).rejects.toBeInstanceOf(SessionBusyError);
        release();
        await first.result;
        // Idle again: the next prompt runs.
        const third = c.startTurn('c', undefined, async (d) => d.end({ stopReason: 'end_turn' }));
        expect((await third.result).stopReason).toBe('end_turn');
    });

    it('with steer, concurrent prompts are allowed', async () => {
        const { core: c } = core({ steer: true });
        const a = c.startTurn('a', undefined, async (d) => {
            await tick(5);
            d.end({ stopReason: 'end_turn' });
        });
        const b = c.startTurn('b', undefined, async (d) => d.end({ stopReason: 'end_turn' }));
        expect((await b.result).stopReason).toBe('end_turn');
        expect((await a.result).stopReason).toBe('end_turn');
    });

    it('resolve() asks the client, respond() answers, state goes awaiting and back', async () => {
        const { core: c } = core();
        const turn = c.startTurn('hi', undefined, async (d, ctx) => {
            const r = await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client', permissionKey: 'rm' });
            d.emit({ type: 'ext', ns: 'test', name: 'decision', data: r.decision });
            d.end({ stopReason: 'end_turn' });
        });
        const seen: AgentEvent[] = [];
        for await (const e of turn) {
            seen.push(e);
            if (e.type === 'request') {
                expect(c.state).toBe('awaiting');
                await c.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
            }
        }
        expect(types(seen)).toEqual(['turn-start', 'request', 'request-resolved', 'ext', 'turn-end']);
        expect(seen[3]).toMatchObject({ data: { outcome: 'allow' } });
        expect(c.state).toBe('idle');
    });

    it('a policy answers without a request; a late respond is a no-op', async () => {
        const { core: c } = core({ policy: allowAll });
        const turn = c.startTurn('hi', undefined, async (d, ctx) => {
            await ctx.resolve({ kind: 'permission', toolName: 'ls', source: 'client' });
            d.end({ stopReason: 'end_turn' });
        });
        const { events } = await drain(turn);
        expect(types(events)).toEqual(['turn-start', 'request-resolved', 'turn-end']);
        await expect(c.respond('nope', { type: 'cancel' })).resolves.toBeUndefined();
    });

    it('headless sessions deny asks; timeouts deny by timeout', async () => {
        const { core: c } = core({ interactive: false });
        const turn = c.startTurn('hi', undefined, async (d, ctx) => {
            const r = await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client' });
            d.end({ stopReason: 'end_turn', output: r.decision });
        });
        expect((await turn.result).output).toMatchObject({ outcome: 'deny' });

        const { core: c2 } = core({ requestTimeoutMs: 5 });
        const turn2 = c2.startTurn('hi', undefined, async (d, ctx) => {
            const r = await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client' });
            d.end({ stopReason: 'end_turn', output: r.by });
        });
        expect((await turn2.result).output).toBe('timeout');
    });

    it('cancel() during an open request resolves it by cancel and the turn ends cancelled', async () => {
        const { core: c } = core();
        const turn = c.startTurn('hi', undefined, async (d, ctx) => {
            const r = await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client' });
            d.emit({ type: 'ext', ns: 'test', name: 'by', data: r.by });
            d.end({ stopReason: 'end_turn' });
        });
        await tick();
        await c.cancel();
        const { events, result } = await drain(turn);
        expect(result.stopReason).toBe('cancelled');
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ by: 'cancel', outcome: 'cancel' });
    });

    it('close() aborts the running turn, waits for it, and ends the log', async () => {
        const { core: c, log } = core();
        const turn = c.startTurn('hi', undefined, async (d) => {
            await new Promise<void>((r) => d.signal.addEventListener('abort', () => r(), { once: true }));
            d.end({ stopReason: 'end_turn' });
        });
        await tick();
        await c.close();
        expect((await turn.result).stopReason).toBe('cancelled');
        expect(c.closed).toBe(true);
        expect(log.closed).toBe(true);
        const after = c.startTurn('x', undefined, async (d) => d.end({ stopReason: 'end_turn' }));
        await expect(after.result).rejects.toThrow(/closed/);
    });

    it('the session signal cancels turns', async () => {
        const ctrl = new AbortController();
        const { core: c } = core({ signal: ctrl.signal });
        const turn = c.startTurn('hi', undefined, async (d) => {
            await new Promise<void>((r) => d.signal.addEventListener('abort', () => r(), { once: true }));
            d.end({ stopReason: 'end_turn' });
        });
        ctrl.abort();
        expect((await turn.result).stopReason).toBe('cancelled');
    });
});
