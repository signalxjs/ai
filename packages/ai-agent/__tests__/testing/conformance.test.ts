/**
 * The conformance suite against `mockAgent` — the reference adapter — with
 * full capabilities, and with reduced ones to prove skips carry reasons and
 * the remaining cases still pass.
 */
import { describe, it, expect } from 'vitest';
import { agentConformance, mockAgent, MOCK_CAPABILITIES, CONFORMANCE_SCENARIOS, checkEventInvariants, checkReplayEquality, ConformanceError, type ConformanceScenario, type MockStep } from '@sigx/ai-agent/testing';
import { createReducer, type AgentEvent, type EventOf } from '@sigx/ai-agent';

/** What the mock does for each scenario — the same behaviour a real adapter's fake would show. */
function scriptFor(scenario: ConformanceScenario): MockStep[] {
    switch (scenario.name) {
        case 'tool-permission':
        case 'headless-deny':
        case 'request-timeout':
            return [{ tool: { name: 'guarded', input: {}, output: { ok: true }, source: 'client' } }, { text: 'Done.' }];
        case 'streaming-tool-input':
            // Split mid-key and mid-value on purpose: a client that only
            // parses on whole chunks would still look right.
            return [{ tool: { name: 'guarded', input: { city: 'Paris' }, inputDeltas: ['{"ci', 'ty":"Pa', 'ris"}'], output: { ok: true }, source: 'client' } }, { text: 'Done.' }];
        case 'session-grant':
            return [{ tool: { name: 'guarded', input: {}, output: { ok: true }, source: 'client' } }, { tool: { name: 'guarded', input: {}, output: { ok: true }, source: 'client' } }, { text: 'Done twice.' }];
        case 'configure':
            return [{ config: [{ id: 'mode', label: 'Mode', values: [{ id: 'ask', label: 'Ask' }, { id: 'plan', label: 'Plan' }], current: 'ask' }] }, { text: 'Hello!' }];
        case 'usage':
            return [{ text: 'Hello!' }, { usage: { inputTokens: 3, outputTokens: 2 } }];
        case 'tool-error':
            return [{ tool: { name: 'failing', input: {}, status: 'failed', error: 'the tool failed on purpose', source: 'client' } }, { text: 'It failed.' }];
        case 'slow-tool':
            return [{ tool: { name: 'slow', input: {}, delayMs: 60_000, source: 'client' } }, { text: 'never' }];
        case 'model-error':
            return [{ error: { code: 'provider_error', message: 'the model is down' } }];
        case 'input-request':
            return [{ request: { kind: 'input', message: 'Yes or no?' } }, { text: 'Thanks.' }];
        case 'structured-output':
            return [{ text: '{"ok":true}' }, { output: { ok: true } }];
        case 'support-agent':
            return [{ request: { kind: 'input', message: 'Which plan?' } }, { ext: { ns: 'agent', name: 'handoff', data: { to: 'billing' } } }, { text: 'Handing over.' }, { output: { ok: true } }];
        case 'delegate-tree':
            return [{ agent: { name: 'delegate', steps: [{ text: 'Delegate reply.' }] } }, { text: 'Done.' }];
        case 'delegate-cancel':
            return [{ agent: { name: 'delegateSlow', steps: [{ tool: { name: 'slow', delayMs: 60_000 } }] } }, { text: 'Moving on.' }];
        case 'delegate-request':
            return [{ agent: { name: 'delegateAsking', source: 'client', steps: [{ tool: { name: 'guarded', source: 'client', output: { ok: true } } }, { text: 'Delegate done.' }] } }, { text: 'Done.' }];
        case 'steer':
            return [{ tool: { name: 'delayed', input: {}, output: { ok: true }, delayMs: 200, source: 'client' } }, { text: 'Done.' }];
        default:
            return [{ text: 'Hello!' }];
    }
}

describe('agentConformance', () => {
    describe('mockAgent with full capabilities', () => {
        const cases = agentConformance((s) => mockAgent({ script: [scriptFor(s), scriptFor(s)] }), { capabilities: MOCK_CAPABILITIES });
        it('covers every scenario and skips nothing', () => {
            expect(cases.map((c) => c.name)).toEqual(CONFORMANCE_SCENARIOS.map((s) => `conformance: ${s.name}`));
            expect(cases.filter((c) => c.skip)).toEqual([]);
        });
        for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
    });

    describe('mockAgent with reduced capabilities', () => {
        const capabilities = { ...MOCK_CAPABILITIES, permissions: 'none' as const, structuredOutput: false, cancel: false, resume: false as const };
        const cases = agentConformance((s) => mockAgent({ capabilities, script: [scriptFor(s), scriptFor(s)] }), { capabilities });
        it('skips with reasons that name the missing capability', () => {
            const skipped = Object.fromEntries(cases.filter((c) => c.skip).map((c) => [c.name, c.skip]));
            expect(skipped).toEqual({
                'conformance: tool-permission': 'needs permissions: "every-call" (agent has "none")',
                'conformance: headless-deny': 'needs permissions: "every-call" (agent has "none")',
                'conformance: slow-tool': 'needs cancel: true (agent has false)',
                'conformance: resume': 'needs the resume capability (agent has resume: false)',
                'conformance: structured-output': 'needs structuredOutput: true (agent has false)',
                'conformance: support-agent': 'needs structuredOutput: true (agent has false)',
                'conformance: session-grant': 'needs permissions: "every-call" (agent has "none")',
                'conformance: request-timeout': 'needs permissions: "every-call" (agent has "none")',
                'conformance: fork': 'needs the resume capability (agent has resume: false)',
                'conformance: portable-resume': 'needs resume: "portable" (agent has false)',
                'conformance: delegate-cancel': 'needs cancel: true (agent has false)',
                'conformance: delegate-request': 'needs permissions: "every-call" (agent has "none")'
            });
        });
        for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
    });

    describe('mockAgent without sub-agents or steering', () => {
        const capabilities = { ...MOCK_CAPABILITIES, subagents: 'none' as const, steer: false };
        const cases = agentConformance((s) => mockAgent({ capabilities, script: [scriptFor(s), scriptFor(s)] }), { capabilities });
        it('skips the delegate and steer scenarios with reasons', () => {
            const skipped = Object.fromEntries(cases.filter((c) => c.skip).map((c) => [c.name, c.skip]));
            expect(skipped).toEqual({
                'conformance: delegate-tree': 'needs subagents: "observe" or "control" (agent has "none")',
                'conformance: delegate-cancel': 'needs subagents: "control" (agent has "none")',
                'conformance: delegate-request': 'needs subagents: "control" (agent has "none")',
                'conformance: steer': 'needs steer: true (agent has false)'
            });
        });
        // busy-session takes the SessionBusyError path here; the rest is unaffected.
        for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
    });

    it("'subagents: observe' in needs accepts control; control must match exactly", () => {
        const observe = agentConformance(() => mockAgent(), { capabilities: { ...MOCK_CAPABILITIES, subagents: 'observe' } });
        expect(observe.find((c) => c.name === 'conformance: delegate-tree')!.skip).toBeUndefined();
        expect(observe.find((c) => c.name === 'conformance: delegate-cancel')!.skip).toBe('needs subagents: "control" (agent has "observe")');
        const control = agentConformance(() => mockAgent(), { capabilities: MOCK_CAPABILITIES });
        expect(control.filter((c) => c.name.startsWith('conformance: delegate') && c.skip)).toEqual([]);
    });

    it("'resume: local' in needs accepts portable; other capability values must match exactly", () => {
        const portable = agentConformance(() => mockAgent(), { capabilities: { ...MOCK_CAPABILITIES, resume: 'portable' } });
        expect(portable.find((c) => c.name === 'conformance: resume')!.skip).toBeUndefined();
        const local = agentConformance(() => mockAgent(), { capabilities: { ...MOCK_CAPABILITIES, resume: 'local' } });
        expect(local.find((c) => c.name === 'conformance: resume')!.skip).toBeUndefined();
        const none = agentConformance(() => mockAgent(), { capabilities: { ...MOCK_CAPABILITIES, resume: false } });
        expect(none.find((c) => c.name === 'conformance: resume')!.skip).toMatch(/resume/);
    });

    it('fails loudly when an agent breaks a scenario', async () => {
        // A mock that never calls the guarded tool.
        const cases = agentConformance(() => mockAgent({ script: [[{ text: 'nope' }]] }), { capabilities: MOCK_CAPABILITIES });
        const perm = cases.find((c) => c.name === 'conformance: tool-permission')!;
        await expect(perm.run()).rejects.toBeInstanceOf(ConformanceError);
    });

    it('invariant checks hold sub-agents to one start, a seen spawning call, and a terminal end', () => {
        const base = { sessionId: 's', epoch: 1, turnId: 't' } as const;
        const turnStart: AgentEvent = { ...base, seq: 1, type: 'turn-start', input: [] };
        const call: AgentEvent = { ...base, seq: 2, type: 'tool-call', callId: 'c1', name: 'delegate' };
        const start: EventOf<'agent-start'> = { ...base, seq: 3, type: 'agent-start', parentCallId: 'c1', agentId: 'a1', callId: 'c1' };
        const done: EventOf<'agent-update'> = { ...base, seq: 4, type: 'agent-update', parentCallId: 'c1', agentId: 'a1', status: 'completed' };
        const settle: AgentEvent = { ...base, seq: 5, type: 'tool-update', callId: 'c1', status: 'completed' };
        const turnEnd: AgentEvent = { ...base, seq: 6, type: 'turn-end', stopReason: 'end_turn' };
        expect(() => checkEventInvariants([turnStart, call, start, done, settle, turnEnd])).not.toThrow();
        // Started twice.
        expect(() => checkEventInvariants([turnStart, call, start, { ...start, seq: 4 }, { ...done, seq: 5 }, { ...settle, seq: 6 }, { ...turnEnd, seq: 7 }])).toThrow(/agent "a1" started twice/);
        // Bound to a call nobody emitted.
        const unbound: EventOf<'agent-start'> = { ...base, seq: 2, type: 'agent-start', agentId: 'a1', callId: 'nope' };
        const unboundDone: EventOf<'agent-update'> = { ...base, seq: 3, type: 'agent-update', agentId: 'a1', status: 'completed' };
        expect(() => checkEventInvariants([turnStart, unbound, unboundDone, { ...turnEnd, seq: 4 }])).toThrow(/agent "a1" .*callId "nope"/);
        // Bound to one call but nested under another (both real).
        const otherCall: AgentEvent = { ...base, seq: 3, type: 'tool-call', callId: 'c2', name: 'delegate' };
        expect(() => checkEventInvariants([turnStart, call, otherCall, { ...start, seq: 4, callId: 'c2', parentCallId: 'c1' }, { ...done, seq: 5 }, { ...settle, seq: 6 }, { ...settle, seq: 7, callId: 'c2' }, { ...turnEnd, seq: 8 }])).toThrow(/agent "a1" .*callId "c2" but nested under "c1"/);
        // A second tool-call reusing a callId.
        expect(() => checkEventInvariants([turnStart, call, { ...call, seq: 3 }, { ...settle, seq: 4 }, { ...turnEnd, seq: 5 }])).toThrow(/tool-call "c1" .*reuses a callId/);
        // Two agents bound to the same spawning call.
        const twin: EventOf<'agent-start'> = { ...start, seq: 4, agentId: 'a2' };
        const twinDone: EventOf<'agent-update'> = { ...done, seq: 6, agentId: 'a2' };
        expect(() => checkEventInvariants([turnStart, call, start, twin, { ...done, seq: 5 }, twinDone, { ...settle, seq: 7 }, { ...turnEnd, seq: 8 }])).toThrow(/agent "a2" .*callId "c1", already bound to agent "a1"/);
        // Updated before it started.
        expect(() => checkEventInvariants([turnStart, call, { ...done, seq: 3 }, { ...settle, seq: 4 }, { ...turnEnd, seq: 5 }])).toThrow(/agent-update for unknown agentId "a1"/);
        // Never reached a terminal status.
        expect(() => checkEventInvariants([turnStart, call, start, { ...done, status: 'running' }, settle, turnEnd])).toThrow(/agent "a1" never reached a terminal status/);
        // A call-less ambient agent needs no call.
        const ambient: AgentEvent = { ...base, seq: 2, type: 'agent-start', agentId: 'obs' };
        const ambientDone: AgentEvent = { ...base, seq: 3, type: 'agent-update', agentId: 'obs', status: 'cancelled' };
        expect(() => checkEventInvariants([turnStart, ambient, ambientDone, { ...turnEnd, seq: 4 }])).not.toThrow();
    });

    it('invariant checks catch a seq gap and a replay mismatch', () => {
        const ok: AgentEvent[] = [
            { type: 'turn-start', turnId: 't', input: [], sessionId: 's', epoch: 1, seq: 1 },
            { type: 'turn-end', turnId: 't', stopReason: 'end_turn', sessionId: 's', epoch: 1, seq: 2 }
        ];
        expect(() => checkEventInvariants(ok)).not.toThrow();
        expect(() => checkEventInvariants([ok[0]!, { ...ok[1]!, seq: 3 }])).toThrow(/seq gap/);
        expect(() => checkEventInvariants([ok[0]!])).toThrow(/turn-end/);
        // An observer that joined mid-way through a LATER epoch: the first event seen in
        // that epoch is the baseline there too, exactly as for the first epoch.
        const midSecondEpoch: AgentEvent[] = [
            { type: 'turn-start', turnId: 't1', input: [], sessionId: 's', epoch: 1, seq: 5 },
            { type: 'turn-end', turnId: 't1', stopReason: 'end_turn', sessionId: 's', epoch: 1, seq: 6 },
            { type: 'turn-start', turnId: 't2', input: [], sessionId: 's', epoch: 2, seq: 4 },
            { type: 'turn-end', turnId: 't2', stopReason: 'end_turn', sessionId: 's', epoch: 2, seq: 5 }
        ];
        expect(() => checkEventInvariants(midSecondEpoch)).not.toThrow();
        // A real gap inside that later epoch is still caught.
        expect(() => checkEventInvariants([midSecondEpoch[0]!, midSecondEpoch[1]!, midSecondEpoch[2]!, { ...midSecondEpoch[3]!, seq: 6 }])).toThrow(/seq gap in epoch 2/);
        // A late joiner that replays from (0, 0) must see every epoch from its first seq.
        expect(() => checkEventInvariants(ok, { fromStart: true })).not.toThrow();
        expect(() => checkEventInvariants(midSecondEpoch, { fromStart: true })).toThrow(/seq gap in epoch 1: expected 1/);
        // A reducer that depends on hidden state is not replayable.
        let calls = 0;
        expect(() =>
            checkReplayEquality(ok, (t, e) => {
                t.ext.calls = ++calls;
                return createReducer()(t, e);
            })
        ).toThrow(/replay from/);
    });
});
