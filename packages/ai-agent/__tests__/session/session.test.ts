import { describe, it, expect } from 'vitest';
import { createEventLog, createSessionCore, SessionBusyError, allowAll, type AgentEvent, type TurnDriver } from '@sigx/ai-agent';
import { collect, drain, types, tick, trackAbortListeners } from '../helpers';

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

    describe('steer', () => {
        it('a prompt while a turn runs steers it: same id and result, one turn, the parts reach onSteer', async () => {
            const { core: c, log } = core({ steer: true });
            const all = collect(log.subscribe());
            const steered: string[] = [];
            let release!: () => void;
            const a = c.startTurn('a', undefined, async (d, ctx) => {
                ctx.onSteer((parts) => {
                    steered.push(parts.map((p) => (p.type === 'text' ? p.text : p.type)).join(''));
                    d.emit({ type: 'user-message', messageId: `u:${d.turnId}:${steered.length}`, parts });
                });
                await new Promise<void>((r) => (release = r));
                d.end({ stopReason: 'end_turn' });
            });
            await tick();
            const b = c.startTurn('also b', { turnId: 'ignored', output: { schema: { type: 'object' } } }, async (d) => d.end({ stopReason: 'error' }));
            expect(b.id).toBe(a.id);
            expect(steered).toEqual(['also b']);
            // The steer handle iterates the running turn from the steer on.
            const seen = collect(b);
            release();
            expect(await b.result).toEqual(await a.result);
            expect((await a.result).stopReason).toBe('end_turn');
            expect(types(await seen)).toEqual(['user-message', 'turn-end']);
            await c.close();
            const events = await all;
            expect(events.filter((e) => e.type === 'turn-start')).toHaveLength(1);
            expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
            expect(events.find((e) => e.type === 'user-message')).toMatchObject({ turnId: a.id, parts: [{ type: 'text', text: 'also b' }] });
        });

        it('a steer before onSteer is registered is queued and flushed on registration', async () => {
            const { core: c } = core({ steer: true });
            const steered: string[] = [];
            let register!: () => void;
            const a = c.startTurn('a', undefined, async (d, ctx) => {
                await new Promise<void>((r) => (register = r));
                ctx.onSteer((parts) => steered.push(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')));
                await tick();
                d.end({ stopReason: 'end_turn' });
            });
            await tick();
            c.startTurn('first', undefined, async (d) => d.end({ stopReason: 'end_turn' }));
            c.startTurn('second', undefined, async (d) => d.end({ stopReason: 'end_turn' }));
            expect(steered).toEqual([]);
            register();
            await a.result;
            expect(steered).toEqual(['first', 'second']);
        });

        it('without the steer capability a prompt during a turn still rejects with SessionBusyError', async () => {
            const { core: c } = core({ steer: false });
            const a = c.startTurn('a', undefined, async (d) => {
                await tick(5);
                d.end({ stopReason: 'end_turn' });
            });
            await expect(c.startTurn('b', undefined, async (d) => d.end({ stopReason: 'end_turn' })).result).rejects.toBeInstanceOf(SessionBusyError);
            await a.result;
        });

        it('steer() with no running turn fails; a steer is gated by promptParts like a prompt', async () => {
            const { core: c } = core({ steer: true, promptParts: 'text' });
            await expect(c.steer('nothing to join').result).rejects.toMatchObject({ code: 'protocol_error', message: expect.stringContaining('no turn is running') });
            const steered: unknown[] = [];
            let release!: () => void;
            const a = c.startTurn('a', undefined, async (d, ctx) => {
                ctx.onSteer((parts) => steered.push(parts));
                await new Promise<void>((r) => (release = r));
                d.end({ stopReason: 'end_turn' });
            });
            await tick();
            const refused = c.startTurn([{ type: 'image', mediaType: 'image/png', data: 'AA==' }], undefined, async (d) => d.end({ stopReason: 'end_turn' }));
            await expect(refused.result).rejects.toThrow(/image part/);
            expect(steered).toEqual([]);
            release();
            await a.result;
        });
    });

    describe('attach', () => {
        it('respond() answers its own request first and forwards unknown ids to attachments', async () => {
            const { core: c } = core();
            const forwarded: string[] = [];
            const detach = c.attach({ respond: async (requestId) => void forwarded.push(requestId) });
            const turn = c.startTurn('hi', undefined, async (d, ctx) => {
                await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client' });
                d.end({ stopReason: 'end_turn' });
            });
            for await (const e of turn) {
                if (e.type === 'request') await c.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
            }
            expect(forwarded).toEqual([]);
            await c.respond('child-req', { type: 'cancel' });
            expect(forwarded).toEqual(['child-req']);
            detach();
            await c.respond('after-detach', { type: 'cancel' });
            expect(forwarded).toEqual(['child-req']);
        });

        it('cancel({ agentId }) forwards to attachments with subagents: control, and is refused otherwise', async () => {
            const { core: c } = core({ subagents: 'control' });
            const targets: string[] = [];
            c.attach({ cancel: async (t) => void targets.push(t.agentId!) });
            let cancelled = false;
            const turn = c.startTurn('hi', undefined, async (d) => {
                await new Promise<void>((r) => d.signal.addEventListener('abort', () => r(), { once: true }));
                cancelled = true;
                d.end({ stopReason: 'end_turn' });
            });
            await tick();
            await c.cancel({ agentId: 'child' });
            expect(targets).toEqual(['child']);
            expect(cancelled).toBe(false);
            // Naming the session itself is the plain cancel.
            await c.cancel({ agentId: 's' });
            expect((await turn.result).stopReason).toBe('cancelled');

            const { core: observe } = core({ subagents: 'observe' });
            await expect(observe.cancel({ agentId: 'child' })).rejects.toMatchObject({ code: 'protocol_error' });
            const { core: none } = core();
            await expect(none.cancel({ agentId: 'child' })).rejects.toMatchObject({ code: 'protocol_error' });
            await expect(none.cancel()).resolves.toBeUndefined();
        });

        it('resolve() with a parentCallId stamps the request and its resolution', async () => {
            const { core: c } = core();
            const turn = c.startTurn('hi', undefined, async (d, ctx) => {
                await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client' }, { parentCallId: 'call_1' });
                d.end({ stopReason: 'end_turn' });
            });
            const seen: AgentEvent[] = [];
            for await (const e of turn) {
                seen.push(e);
                if (e.type === 'request') await c.respond(e.requestId, { type: 'permission', outcome: 'deny', scope: 'once' });
            }
            expect(seen.filter((e) => e.type === 'request' || e.type === 'request-resolved').map((e) => e.parentCallId)).toEqual(['call_1', 'call_1']);
        });
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

    it('an answered request leaves no abort listener on the turn signal', async () => {
        const { core: c } = core();
        let leaked = -1;
        const turn = c.startTurn('hi', undefined, async (d, ctx) => {
            const listeners = trackAbortListeners(d.signal);
            await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client' });
            await ctx.resolve({ kind: 'permission', toolName: 'rm', source: 'client' });
            leaked = listeners();
            d.end({ stopReason: 'end_turn' });
        });
        for await (const e of turn) {
            if (e.type === 'request') await c.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        }
        expect(leaked).toBe(0);
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

    it('promptParts gates image, file and resource parts before the turn starts', async () => {
        const image = { type: 'image' as const, mediaType: 'image/png', data: 'AA==' };
        const file = { type: 'file' as const, mediaType: 'text/plain', data: 'aGk=', filename: 'a.txt' };
        const resource = { type: 'resource' as const, uri: 'file:///a.txt' };
        const run = async (d: TurnDriver) => d.end({ stopReason: 'end_turn' });

        const { core: text, log } = core({ promptParts: 'text' });
        const all = collect(log.subscribe());
        const refused = text.startTurn([{ type: 'text', text: 'see' }, image], { turnId: 'img' }, run);
        expect(refused.id).toBe('img');
        await expect(refused.result).rejects.toMatchObject({ code: 'protocol_error', message: expect.stringContaining('promptParts "text"') });
        expect((await text.startTurn('plain', undefined, run).result).stopReason).toBe('end_turn');
        await text.close();
        // The refused prompt left no trace in the log.
        expect((await all).filter((e) => e.type === 'turn-start')).toHaveLength(1);

        const { core: withImage } = core({ promptParts: 'text+image' });
        expect((await withImage.startTurn([image], undefined, run).result).stopReason).toBe('end_turn');
        await expect(withImage.startTurn([file], undefined, run).result).rejects.toThrow(/file part/);
        await expect(withImage.startTurn([resource], undefined, run).result).rejects.toThrow(/resource part/);

        const { core: everything } = core({ promptParts: 'text+image+file' });
        expect((await everything.startTurn([image, file, resource], undefined, run).result).stopReason).toBe('end_turn');
        // The default accepts everything, so adapters that do not pass it are unchanged.
        const { core: dflt } = core();
        expect((await dflt.startTurn([image, file, resource], undefined, run).result).stopReason).toBe('end_turn');
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
