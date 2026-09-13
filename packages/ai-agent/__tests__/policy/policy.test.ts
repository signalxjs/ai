import { describe, it, expect } from 'vitest';
import { resolveRequest, createGrants, allowAll, denyAll, type Decision, type ResolveContext, type UnstampedEvent, type PolicyRequest } from '@sigx/ai-agent';
import { tick } from '../helpers';

function harness(overrides: Partial<ResolveContext> = {}) {
    const events: UnstampedEvent[] = [];
    const pending = new Map<string, (d: Decision) => void>();
    const ctx: ResolveContext = {
        sessionId: 's',
        turnId: 't',
        interactive: true,
        grants: createGrants(),
        signal: new AbortController().signal,
        now: () => 1000,
        newId: () => 'req_1',
        emit: (e) => {
            events.push(e);
        },
        awaitClient: (id, signal) =>
            new Promise<Decision>((resolve, reject) => {
                pending.set(id, resolve);
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        ...overrides
    };
    return { ctx, events, respond: (id: string, d: Decision) => pending.get(id)?.(d) };
}

const perm: PolicyRequest = { kind: 'permission', toolName: 'rm', input: { path: '/x' }, source: 'client', permissionKey: 'rm:/x', callId: 'c1' };

describe('resolveRequest', () => {
    it('a policy allow settles without asking and emits one request-resolved with at', async () => {
        const h = harness({ policy: allowAll });
        const r = await resolveRequest(perm, h.ctx);
        expect(r).toMatchObject({ requestId: 'req_1', by: 'policy', ruleId: 'allowAll', decision: { outcome: 'allow' } });
        expect(h.events).toEqual([{ type: 'request-resolved', requestId: 'req_1', outcome: 'allow', scope: 'once', by: 'policy', ruleId: 'allowAll', at: 1000, turnId: 't' }]);
    });

    it('a policy deny carries the message back', async () => {
        const h = harness({ policy: denyAll });
        const r = await resolveRequest(perm, h.ctx);
        expect(r.decision).toMatchObject({ outcome: 'deny', message: expect.stringContaining('rm') });
        expect(h.events[0]).toMatchObject({ type: 'request-resolved', outcome: 'deny', by: 'policy' });
    });

    it("'ask' on a headless session denies once with a message (permission) or cancels (input)", async () => {
        const h = harness({ interactive: false });
        const r = await resolveRequest(perm, h.ctx);
        expect(r).toMatchObject({ by: 'policy', reason: 'non-interactive', decision: { outcome: 'deny', scope: 'once', message: expect.stringContaining('not interactive') } });
        expect(h.events.map((e) => e.type)).toEqual(['request-resolved']);
        const i = await resolveRequest({ kind: 'input', source: 'native' }, harness({ interactive: false }).ctx);
        expect(i.decision).toEqual({ type: 'cancel' });
    });

    it("'ask' on an interactive session emits a request and settles with the client's answer", async () => {
        const h = harness();
        const p = resolveRequest(perm, h.ctx);
        await tick();
        expect(h.events[0]).toEqual({ type: 'request', requestId: 'req_1', kind: 'permission', callId: 'c1', toolName: 'rm', permissionKey: 'rm:/x', turnId: 't' });
        h.respond('req_1', { type: 'permission', outcome: 'allow', scope: 'session' });
        const r = await p;
        expect(r).toMatchObject({ by: 'client', decision: { outcome: 'allow', scope: 'session' } });
        expect(h.events[1]).toMatchObject({ type: 'request-resolved', outcome: 'allow', scope: 'session', by: 'client', at: 1000 });
        // A session-scoped allow is remembered and reused without asking.
        expect(h.ctx.grants.has('rm:/x')).toBe(true);
        const again = await resolveRequest(perm, h.ctx);
        expect(again).toMatchObject({ by: 'policy', reason: 'session grant', ruleId: 'grant' });
        expect(h.events).toHaveLength(3);
    });

    it('a timeout denies with by: timeout', async () => {
        const h = harness({ timeoutMs: 5 });
        const r = await resolveRequest(perm, h.ctx);
        expect(r).toMatchObject({ by: 'timeout', decision: { outcome: 'deny' } });
        expect(h.events.map((e) => e.type)).toEqual(['request', 'request-resolved']);
    });

    it('cancelling the turn while a request is open resolves it by: cancel', async () => {
        const ctrl = new AbortController();
        const h = harness({ signal: ctrl.signal });
        const p = resolveRequest(perm, h.ctx);
        await tick();
        ctrl.abort();
        const r = await p;
        expect(r).toMatchObject({ by: 'cancel', decision: { type: 'cancel' } });
        expect(h.events[1]).toMatchObject({ type: 'request-resolved', outcome: 'cancel', by: 'cancel' });
    });

    it('an already-aborted turn answers cancel without asking', async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const h = harness({ signal: ctrl.signal, policy: allowAll });
        const r = await resolveRequest(perm, h.ctx);
        expect(r.by).toBe('cancel');
        expect(h.events).toHaveLength(1);
    });

    it('an input decision carries answers on the resolved event', async () => {
        const h = harness();
        const p = resolveRequest({ kind: 'input', source: 'native', message: 'Which region?' }, h.ctx);
        await tick();
        expect(h.events[0]).toMatchObject({ type: 'request', kind: 'input', message: 'Which region?' });
        h.respond('req_1', { type: 'input', answers: { region: 'eu' } });
        expect(await p).toMatchObject({ decision: { type: 'input', answers: { region: 'eu' } } });
        expect(h.events[1]).toMatchObject({ outcome: 'input', answers: { region: 'eu' } });
    });

    it('reuses a request id the harness supplied', async () => {
        const h = harness({ requestId: 'harness-7', policy: allowAll });
        expect((await resolveRequest(perm, h.ctx)).requestId).toBe('harness-7');
    });
});
