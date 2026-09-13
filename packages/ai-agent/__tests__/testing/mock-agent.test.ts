import { describe, it, expect } from 'vitest';
import { allowAll, allowReadOnly, denyAll, firstMatch, type AgentEvent } from '@sigx/ai-agent';
import { mockAgent, MOCK_CAPABILITIES } from '@sigx/ai-agent/testing';
import { collect, drain, types, textOf, expectJsonSafe } from '../helpers';

describe('mockAgent', () => {
    it('streams a scripted text turn as parts and ends end_turn', async () => {
        const agent = mockAgent({ script: [[{ reasoning: 'thinking…', text: 'Hello brave new world' }]] });
        expect(agent.capabilities).toEqual(MOCK_CAPABILITIES);
        const session = await agent.session();
        const { events, result } = await drain(session.prompt('hi'));
        expect(types(events).slice(0, 3)).toEqual(['turn-start', 'user-message', 'part-start']);
        expect(events.filter((e) => e.type === 'part-start').map((e) => (e as Extract<AgentEvent, { type: 'part-start' }>).kind)).toEqual(['reasoning', 'text']);
        expect(textOf(events)).toBe('thinking…Hello brave new world');
        expect(result.stopReason).toBe('end_turn');
        expect(events.every((e) => e.sessionId === session.id)).toBe(true);
        // Turn events are strictly increasing; session-level events (state) fill the gaps.
        expect(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq)).toBe(true);
        expectJsonSafe(events);
        expect(agent.sessions).toHaveLength(1);
        await agent.dispose();
    });

    it('later turns fall back to a default reply; script turns play in order', async () => {
        const agent = mockAgent({ script: [[{ text: 'one' }], [{ text: 'two' }]] });
        const session = await agent.session();
        expect(textOf((await drain(session.prompt('a'))).events)).toBe('one');
        expect(textOf((await drain(session.prompt('b'))).events)).toBe('two');
        expect(textOf((await drain(session.prompt('c'))).events)).toBe('Mock reply 3.');
    });

    it('tool steps go through the policy: allow runs, deny is denied, the turn continues', async () => {
        const agent = mockAgent({
            script: [[{ tool: { name: 'read', input: { path: 'a' }, output: 'contents', annotations: { readOnly: true }, category: 'read' } }, { tool: { name: 'rm', input: { path: 'a' } } }, { text: 'done' }]]
        });
        const session = await agent.session({ interactive: false, policy: firstMatch(allowReadOnly) });
        const { events, result } = await drain(session.prompt('go'));
        const updates = events.filter((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update');
        expect(updates.filter((u) => u.callId === updates[0]!.callId).map((u) => u.status)).toEqual(['pending', 'in_progress', 'completed']);
        const rm = updates.filter((u) => u.callId !== updates[0]!.callId);
        expect(rm.map((u) => u.status)).toEqual(['pending', 'denied']);
        expect(rm[1]!.error).toMatch(/not interactive/);
        const resolved = events.filter((e) => e.type === 'request-resolved');
        expect(resolved).toHaveLength(2);
        expect(resolved[0]).toMatchObject({ outcome: 'allow', by: 'policy', ruleId: 'allowReadOnly' });
        expect(resolved[1]).toMatchObject({ outcome: 'deny', by: 'policy', reason: 'non-interactive' });
        expect(result.stopReason).toBe('end_turn');
        expect(textOf(events)).toBe('done');
    });

    it('an interactive session asks and respond() answers; a session grant skips the second ask', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'rm', input: { path: 'a' } } }, { tool: { name: 'rm', input: { path: 'b' } } }]] });
        const session = await agent.session();
        const turn = session.prompt('go');
        const seen: AgentEvent[] = [];
        for await (const e of turn) {
            seen.push(e);
            if (e.type === 'request') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
        }
        expect(seen.filter((e) => e.type === 'request')).toHaveLength(1);
        expect(seen.filter((e) => e.type === 'request-resolved').map((e) => (e as Extract<AgentEvent, { type: 'request-resolved' }>).by)).toEqual(['client', 'policy']);
        expect(seen.filter((e) => e.type === 'tool-update' && (e as Extract<AgentEvent, { type: 'tool-update' }>).status === 'completed')).toHaveLength(2);
    });

    it('cancel during a slow tool ends the turn cancelled', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'slow', delayMs: 1000 } }, { text: 'never' }]] });
        const session = await agent.session({ policy: allowAll });
        const turn = session.prompt('go');
        for await (const e of turn) {
            if (e.type === 'tool-update' && e.status === 'in_progress') await session.cancel();
        }
        const result = await turn.result;
        expect(result.stopReason).toBe('cancelled');
        const events = await collect(turn);
        expect(events.find((e) => e.type === 'tool-update' && e.status === 'cancelled')).toBeDefined();
        expect(textOf(events)).toBe('');
    });

    it('a non-coding scenario: input request, handoff ext and structured output', async () => {
        const agent = mockAgent({
            respond: (_input, turn, ctx) =>
                turn === 0
                    ? [{ request: { kind: 'input', message: 'Which plan?', options: [{ id: 'pro', label: 'Pro' }] } }, { ext: { ns: 'agent', name: 'handoff', data: { to: 'billing' } } }, { text: 'Handing over.' }]
                    : [{ text: `You chose ${String((ctx.answers[0] as { plan: string }).plan)}.` }, { output: { plan: (ctx.answers[0] as { plan: string }).plan } }]
        });
        const session = await agent.session();
        const first = session.prompt('upgrade me');
        for await (const e of first) {
            if (e.type === 'request') {
                expect(e).toMatchObject({ kind: 'input', message: 'Which plan?' });
                await session.respond(e.requestId, { type: 'input', answers: { plan: 'pro' } });
            }
        }
        const firstEvents = await collect(first);
        expect(firstEvents.find((e) => e.type === 'ext')).toMatchObject({ ns: 'agent', name: 'handoff', data: { to: 'billing' } });
        const { events, result } = await drain(session.prompt('ok'));
        expect(textOf(events)).toBe('You chose pro.');
        expect(result.output).toEqual({ plan: 'pro' });
    });

    it('errors end the turn with stopReason error', async () => {
        const agent = mockAgent({ script: [[{ text: 'partial' }, { error: { code: 'rate_limited', message: 'slow down', recoverable: true } }]] });
        const session = await agent.session();
        const { events, result } = await drain(session.prompt('go'));
        expect(result).toMatchObject({ stopReason: 'error', error: { code: 'rate_limited' } });
        expect(events.at(-2)).toMatchObject({ type: 'error', recoverable: true });
    });

    it('resumes a session from its ref in a new epoch, continuing the script', async () => {
        const agent = mockAgent({ script: [[{ text: 'one' }], [{ text: 'two' }]] });
        const s1 = await agent.session();
        await s1.prompt('a').result;
        const ref = s1.ref;
        await s1.close();
        const s2 = await agent.session({ resume: ref });
        expect(s2.id).toBe(s1.id);
        const { events } = await drain(s2.prompt('b'));
        expect(textOf(events)).toBe('two');
        expect(events[0]!.epoch).toBe(2);
        expect(events[0]!.seq).toBe(1);
    });

    it('honest capabilities: without structuredOutput the output step is ignored; without resume the ref is refused', async () => {
        const agent = mockAgent({ capabilities: { structuredOutput: false, resume: false }, script: [[{ output: { a: 1 } }, { text: 'x' }]] });
        const session = await agent.session();
        expect((await session.prompt('go').result).output).toBeUndefined();
        await expect(agent.session({ resume: session.ref })).rejects.toThrow(/cannot resume/);
    });

    it('with permissions: none, tools run without asking', async () => {
        const agent = mockAgent({ capabilities: { permissions: 'none' }, script: [[{ tool: { name: 'rm' } }]] });
        const session = await agent.session({ policy: denyAll });
        const { events } = await drain(session.prompt('go'));
        expect(events.filter((e) => e.type === 'request-resolved')).toHaveLength(0);
        expect(events.find((e) => e.type === 'tool-update' && e.status === 'completed')).toBeDefined();
    });

    it('config steps and configure() emit config events', async () => {
        const agent = mockAgent({ script: [[{ config: [{ id: 'mode', label: 'Mode', values: [{ id: 'ask' }, { id: 'auto' }], current: 'ask' }] }]] });
        const session = await agent.session();
        const all = collect(session.subscribe());
        await session.prompt('go').result;
        await session.configure!({ mode: 'auto' });
        await session.close();
        const configs = (await all).filter((e): e is Extract<AgentEvent, { type: 'config' }> => e.type === 'config');
        expect(configs.map((c) => c.options[0]!.current)).toEqual(['ask', 'auto']);
    });
});
