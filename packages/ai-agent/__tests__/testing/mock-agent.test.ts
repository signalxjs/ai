import { describe, it, expect } from 'vitest';
import { allowAll, allowReadOnly, denyAll, firstMatch, createReducer, createTranscript, spawnedAgent, agentTree, SessionBusyError, type AgentEvent, type AgentSession } from '@sigx/ai-agent';
import { mockAgent, MOCK_CAPABILITIES, checkEventInvariants, checkReplayEquality, type MockStep } from '@sigx/ai-agent/testing';
import { collect, drain, types, textOf, expectJsonSafe } from '../helpers';

type Ev<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;
const ofType = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) => events.filter((e): e is Ev<T> => e.type === type);

/** Every event of the session (gapless, so the invariants can be checked), then the reduced transcript. */
async function record(session: AgentSession, run: () => Promise<void>) {
    const all = collect(session.subscribe({ epoch: 0, seq: 0 }));
    await run();
    await session.close();
    const events = await all;
    checkEventInvariants(events, { fromStart: true });
    checkReplayEquality(events, createReducer());
    const transcript = createTranscript(session.id);
    const reduce = createReducer();
    for (const e of events) reduce(transcript, e);
    return { events, transcript };
}

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

    it('a session grant survives resume', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'rm' } }], [{ tool: { name: 'rm' } }]] });
        const s1 = await agent.session();
        const first = s1.prompt('go');
        for await (const e of first) if (e.type === 'request') await s1.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
        await first.result;
        const ref = s1.ref;
        await s1.close();
        const s2 = await agent.session({ resume: ref });
        const { events } = await drain(s2.prompt('again'));
        expect(events.filter((e) => e.type === 'request')).toHaveLength(0);
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'allow', by: 'policy', ruleId: 'grant' });
        // A fork is a new session: grants do not carry over.
        const forked = await mockAgent({ capabilities: { fork: true }, script: [[], [{ tool: { name: 'rm' } }]] }).session({ resume: ref, fork: true });
        const forkedTurn = forked.prompt('x');
        const seen: AgentEvent[] = [];
        for await (const e of forkedTurn) {
            seen.push(e);
            if (e.type === 'request') await forked.respond(e.requestId, { type: 'permission', outcome: 'deny', scope: 'once' });
        }
        expect(seen.filter((e) => e.type === 'request')).toHaveLength(1);
    });

    it('imports a portable transcript through the ref, and refuses one without importTranscript', async () => {
        const messages = [
            { id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'earlier' }] },
            { id: 'a1', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'reply' }] }
        ];
        const agent = mockAgent({ script: [[{ text: 'first' }], [{ text: 'second' }]] });
        const session = await agent.session({ resume: { agent: 'mock', v: 1, id: 'imported', data: { messages } } });
        const all = collect(session.subscribe({ epoch: 0, seq: 0 }));
        await session.prompt('now').result;
        await session.close();
        const events = await all;
        expect(types(events).slice(0, 4)).toEqual(['user-message', 'part-start', 'part-delta', 'part-end']);
        expect(events[0]).toMatchObject({ messageId: 'u1', parts: [{ type: 'text', text: 'earlier' }] });
        expect(events.every((e) => e.sessionId === 'imported')).toBe(true);
        // One imported user message = one turn already played: the script continues at index 1.
        expect(textOf(events)).toBe('replysecond');
        expectJsonSafe(events);

        const honest = mockAgent({ capabilities: { importTranscript: false } });
        await expect(honest.session({ resume: { agent: 'mock', v: 1, id: 'x', data: { messages } } })).rejects.toThrow(/cannot import/);
    });

    it('an agent step spawns a sub-agent: nested events under the spawning call, one terminal update', async () => {
        const agent = mockAgent({ script: [[{ agent: { name: 'delegate', title: 'Look it up', steps: [{ text: 'Delegate reply.' }, { usage: { outputTokens: 7 } }], output: { found: true } } }, { text: 'Done.' }]] });
        const session = await agent.session({ interactive: false, policy: allowAll });
        let result: Awaited<ReturnType<typeof drain>>['result'] | undefined;
        const { events, transcript } = await record(session, async () => {
            result = (await drain(session.prompt('go'))).result;
        });
        const call = ofType(events, 'tool-call')[0]!;
        const start = ofType(events, 'agent-start')[0]!;
        expect(start).toMatchObject({ agentId: 'agent_1', callId: call.callId, kind: 'delegate', title: 'Look it up', parentCallId: call.callId });
        const updates = ofType(events, 'agent-update');
        expect(updates.map((u) => u.status)).toEqual(['running', 'completed']);
        expect(updates[1]).toMatchObject({ output: { found: true }, usage: { outputTokens: 7 } });
        // The sub-agent's parts nest under the call, in their own assistant message; the turn's own text does not.
        const parts = ofType(events, 'part-start');
        expect(parts[0]).toMatchObject({ parentCallId: call.callId, messageId: `a:${call.turnId}:${call.callId}:0` });
        expect(parts[1]).toMatchObject({ messageId: `a:${call.turnId}:0` });
        expect(parts[1]!.parentCallId).toBeUndefined();
        expect(textOf(events)).toBe('Delegate reply.Done.');
        // The spawning call completes with the sub-agent's output; nested usage never reaches the session's totals.
        expect(ofType(events, 'tool-update').map((u) => u.status)).toEqual(['pending', 'in_progress', 'completed']);
        expect(ofType(events, 'tool-update').at(-1)).toMatchObject({ output: { found: true } });
        expect(ofType(events, 'usage')).toHaveLength(0);
        expect(result).toMatchObject({ stopReason: 'end_turn' });
        expect(result!.usage).toBeUndefined();
        const seq = types(events).filter((t) => t !== 'state');
        expect(seq.slice(0, 7)).toEqual(['turn-start', 'user-message', 'tool-call', 'tool-update', 'request-resolved', 'agent-start', 'tool-update']);
        // Reduced: one agent at depth 0, bound to the call, with its message.
        expect(spawnedAgent(transcript, call.callId)).toMatchObject({ agentId: 'agent_1', depth: 0, status: 'completed' });
        expect(agentTree(transcript)).toHaveLength(1);
        expectJsonSafe(events);
    });

    it('a sub-agent asks through the parent session; the answer reaches it', async () => {
        const agent = mockAgent({ script: [[{ agent: { name: 'delegate', steps: [{ tool: { name: 'guarded', source: 'client', output: { ok: true } } }, { text: 'ok' }] } }]] });
        const session = await agent.session();
        const { events } = await record(session, async () => {
            const turn = session.prompt('go');
            // The spawning call asks first (top level), then the sub-agent's own tool asks (nested); one respond() answers either.
            for await (const e of turn) if (e.type === 'request') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
            expect((await turn.result).stopReason).toBe('end_turn');
        });
        const spawnCall = ofType(events, 'tool-call')[0]!;
        const nestedCall = ofType(events, 'tool-call')[1]!;
        expect(nestedCall).toMatchObject({ name: 'guarded', parentCallId: spawnCall.callId });
        const requests = ofType(events, 'request');
        expect(requests.map((r) => r.parentCallId)).toEqual([undefined, spawnCall.callId]);
        expect(ofType(events, 'request-resolved')[1]).toMatchObject({ by: 'client', outcome: 'allow', parentCallId: spawnCall.callId });
        expect(ofType(events, 'tool-update').filter((u) => u.callId === nestedCall.callId).map((u) => u.status)).toEqual(['pending', 'in_progress', 'completed']);
        expect(ofType(events, 'agent-update').at(-1)).toMatchObject({ status: 'completed' });
    });

    it('cancel({ agentId }) stops one sub-agent; the turn goes on', async () => {
        const agent = mockAgent({ script: [[{ agent: { name: 'slowpoke', steps: [{ tool: { name: 'slow', delayMs: 60_000 } }, { text: 'never' }] } }, { text: 'Carried on.' }]] });
        const session = await agent.session({ interactive: false, policy: allowAll });
        const { events, transcript } = await record(session, async () => {
            const turn = session.prompt('go');
            for await (const e of turn) if (e.type === 'agent-update' && e.status === 'running') await session.cancel({ agentId: e.agentId });
            expect((await turn.result).stopReason).toBe('end_turn');
            // An unknown target is a no-op, like a late respond.
            await session.cancel({ agentId: 'nobody' });
        });
        const spawnCall = ofType(events, 'tool-call')[0]!;
        expect(ofType(events, 'agent-update').map((u) => u.status)).toEqual(['running', 'cancelled']);
        expect(ofType(events, 'tool-update').filter((u) => u.callId !== spawnCall.callId).map((u) => u.status)).toEqual(['pending', 'in_progress', 'cancelled']);
        expect(ofType(events, 'tool-update').filter((u) => u.callId === spawnCall.callId).map((u) => u.status)).toEqual(['pending', 'in_progress', 'cancelled']);
        expect(textOf(events)).toBe('Carried on.');
        expect(transcript.agents.agent_1).toMatchObject({ status: 'cancelled' });
    });

    it('a grandchild nests under its parent agent', async () => {
        const script: MockStep[] = [{ agent: { name: 'lead', steps: [{ agent: { name: 'helper', steps: [{ text: 'deep' }] } }, { text: 'lead done' }] } }];
        const agent = mockAgent({ script: [script] });
        const session = await agent.session({ interactive: false, policy: allowAll });
        const { events, transcript } = await record(session, async () => {
            await session.prompt('go').result;
        });
        const [leadCall, helperCall] = ofType(events, 'tool-call');
        expect(helperCall).toMatchObject({ name: 'helper', parentCallId: leadCall!.callId });
        const [leadStart, helperStart] = ofType(events, 'agent-start');
        expect(helperStart).toMatchObject({ callId: helperCall!.callId, parentCallId: helperCall!.callId });
        expect(ofType(events, 'part-start')[0]).toMatchObject({ parentCallId: helperCall!.callId });
        expect(transcript.agents[helperStart!.agentId]).toMatchObject({ depth: 1, parentAgentId: leadStart!.agentId });
        expect(agentTree(transcript)[0]!.children[0]!.agent.agentId).toBe(helperStart!.agentId);
        // Both terminal, inner first.
        expect(ofType(events, 'agent-update').filter((u) => u.status === 'completed').map((u) => u.agentId)).toEqual([helperStart!.agentId, leadStart!.agentId]);
    });

    it('a failed sub-agent fails its call and the turn continues', async () => {
        const agent = mockAgent({ script: [[{ agent: { name: 'flaky', steps: [{ error: { code: 'provider_error', message: 'boom' } }] } }, { agent: { name: 'judged', steps: [], status: 'failed', error: 'no good' } }, { text: 'still here' }]] });
        const session = await agent.session({ interactive: false, policy: allowAll });
        const { events } = await record(session, async () => {
            expect((await session.prompt('go').result).stopReason).toBe('end_turn');
        });
        const updates = ofType(events, 'agent-update').filter((u) => u.status !== 'running');
        expect(updates[0]).toMatchObject({ agentId: 'agent_1', status: 'failed', error: { code: 'provider_error', message: 'boom' } });
        expect(updates[1]).toMatchObject({ agentId: 'agent_2', status: 'failed', error: { message: 'no good' } });
        expect(ofType(events, 'tool-update').filter((u) => u.status === 'failed').map((u) => u.error)).toEqual(['boom', 'no good']);
        expect(ofType(events, 'error')[0]).toMatchObject({ parentCallId: ofType(events, 'tool-call')[0]!.callId });
        expect(textOf(events)).toBe('still here');
    });

    it('with subagents: none the agent step runs as a plain tool call', async () => {
        const agent = mockAgent({ capabilities: { subagents: 'none' }, script: [[{ agent: { name: 'hidden', steps: [{ text: 'invisible' }], output: 'result' } }]] });
        const session = await agent.session({ interactive: false, policy: allowAll });
        const { events } = await drain(session.prompt('go'));
        expect(types(events)).not.toContain('agent-start');
        expect(textOf(events)).toBe('');
        expect(ofType(events, 'tool-update').at(-1)).toMatchObject({ status: 'completed', output: 'result' });
        await expect(session.cancel({ agentId: 'agent_1' })).rejects.toMatchObject({ code: 'protocol_error' });
    });

    it('steering: a prompt during the turn joins it, and its reply plays before the next step', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'guarded', output: 1 } }, { text: 'Done.' }]], steer: (input) => [{ text: `Noted: ${input.map((p) => (p.type === 'text' ? p.text : '')).join('')}` }] });
        const session = await agent.session();
        let first!: ReturnType<AgentSession['prompt']>;
        let second!: ReturnType<AgentSession['prompt']>;
        const { events } = await record(session, async () => {
            first = session.prompt('go');
            for await (const e of first) {
                if (e.type === 'request') {
                    second = session.prompt('also thanks');
                    expect(second.id).toBe(first.id);
                    await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
                }
            }
            expect(await second.result).toEqual(await first.result);
            // The steer's handle iterates from the steer on: its user-message first, then the rest of the turn.
            const fromSteer = await collect(second);
            expect(fromSteer[0]).toMatchObject({ type: 'user-message', parts: [{ type: 'text', text: 'also thanks' }] });
            expect(fromSteer.at(-1)!.type).toBe('turn-end');
        });
        const turnId = first.id;
        const users = ofType(events, 'user-message');
        expect(users).toHaveLength(2);
        expect(users[1]).toMatchObject({ messageId: `u:${turnId}:1`, turnId, parts: [{ type: 'text', text: 'also thanks' }] });
        expect(users[1]!.parentCallId).toBeUndefined();
        expect(users[1]!.seq).toBeGreaterThan(ofType(events, 'request')[0]!.seq);
        expect(users[1]!.seq).toBeLessThan(ofType(events, 'request-resolved')[0]!.seq);
        expect(ofType(events, 'turn-start')).toHaveLength(1);
        expect(ofType(events, 'turn-end')).toHaveLength(1);
        // The reply opens a new assistant message; the turn's remaining text follows in it.
        const parts = ofType(events, 'part-start');
        expect(parts.map((p) => p.messageId)).toEqual([`a:${turnId}:1`, `a:${turnId}:1`]);
        expect(textOf(events)).toBe('Noted: also thanksDone.');
        expect(ofType(events, 'tool-update').at(-1)).toMatchObject({ status: 'completed' });
        expect(parts[0]!.seq).toBeGreaterThan(ofType(events, 'tool-update').at(-1)!.seq);
    });

    it('steering has a default reply, and no turn to steer fails the prompt', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'slow', delayMs: 20 } }], [{ text: 'two' }]] });
        const session = await agent.session({ policy: allowAll });
        const first = session.prompt('one');
        const second = session.prompt('steer');
        expect(second.id).toBe(first.id);
        const { events } = await drain(first);
        expect(textOf(events)).toBe('Steered.');
        // Between turns a prompt is a new turn, playing the next script entry.
        expect(textOf((await drain(session.prompt('next'))).events)).toBe('two');
    });

    it('without the steer capability a prompt during the turn rejects with SessionBusyError', async () => {
        const agent = mockAgent({ capabilities: { steer: false }, script: [[{ tool: { name: 'slow', delayMs: 20 } }]] });
        const session = await agent.session({ policy: allowAll });
        const first = session.prompt('one');
        await expect(session.prompt('two').result).rejects.toBeInstanceOf(SessionBusyError);
        expect((await first.result).stopReason).toBe('end_turn');
        // The refused prompt consumed no script turn.
        expect(textOf((await drain(session.prompt('three'))).events)).toBe('Mock reply 2.');
    });

    it('honest capabilities: cancel is a no-op without cancel; promptParts is enforced', async () => {
        const noCancel = mockAgent({ capabilities: { cancel: false }, script: [[{ tool: { name: 'slow', delayMs: 20 } }, { text: 'done' }]] });
        const s1 = await noCancel.session({ policy: allowAll });
        const turn = s1.prompt('go');
        for await (const e of turn) if (e.type === 'tool-update' && e.status === 'in_progress') await s1.cancel();
        expect((await turn.result).stopReason).toBe('end_turn');

        const textOnly = mockAgent({ capabilities: { promptParts: 'text' } });
        const s2 = await textOnly.session();
        const all = collect(s2.subscribe());
        const refused = s2.prompt([{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }]);
        await expect(refused.result).rejects.toMatchObject({ code: 'protocol_error', message: expect.stringContaining('promptParts') });
        expect((await s2.prompt('plain').result).stopReason).toBe('end_turn');
        await s2.close();
        // The refused prompt left no trace in the log.
        expect((await all).filter((e) => e.type === 'turn-start')).toHaveLength(1);
    });
});
