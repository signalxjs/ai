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
            return [{ tool: { name: 'guarded', input: {}, output: { ok: true }, source: 'client' } }, { text: 'Done.' }];
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
                'conformance: support-agent': 'needs structuredOutput: true (agent has false)'
            });
        });
        for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
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
