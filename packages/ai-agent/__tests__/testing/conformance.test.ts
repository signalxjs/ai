/**
 * The conformance suite against `mockAgent` — the reference adapter — with
 * full capabilities, and with reduced ones to prove skips carry reasons and
 * the remaining cases still pass.
 */
import { describe, it, expect } from 'vitest';
import { agentConformance, mockAgent, MOCK_CAPABILITIES, CONFORMANCE_SCENARIOS, checkEventInvariants, checkReplayEquality, ConformanceError, type ConformanceScenario, type MockStep } from '@sigx/ai-agent/testing';
import { createReducer, type AgentEvent } from '@sigx/ai-agent';

/** What the mock does for each scenario — the same behaviour a real adapter's fake would show. */
function scriptFor(scenario: ConformanceScenario): MockStep[] {
    switch (scenario.name) {
        case 'tool-permission':
        case 'headless-deny':
        case 'request-timeout':
            return [{ tool: { name: 'guarded', input: {}, output: { ok: true }, source: 'client' } }, { text: 'Done.' }];
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
                'conformance: portable-resume': 'needs resume: "portable" (agent has false)'
            });
        });
        for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
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
