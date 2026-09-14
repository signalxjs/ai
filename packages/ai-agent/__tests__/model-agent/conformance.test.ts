/** The conformance suite against our own engine: `modelAgent` over a scripted `mockModel`. */
import { describe, it, expect } from 'vitest';
import { mockModel, type MockReply } from '@sigx/ai/testing';
import { modelAgent, MODEL_AGENT_CAPABILITIES } from '@sigx/ai-agent';
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';

/** What the model does for each scenario (the tools come from the scenario). */
function respondFor(scenario: ConformanceScenario) {
    return (_req: unknown, round: number): MockReply => {
        switch (scenario.name) {
            case 'tool-permission':
            case 'headless-deny':
            case 'request-timeout':
                return round === 0 ? { toolCalls: [{ name: 'guarded', input: {}, id: 'g1' }] } : { text: 'Done.' };
            case 'session-grant':
                return round < 2 ? { toolCalls: [{ name: 'guarded', input: {}, id: `g${round + 1}` }] } : { text: 'Done twice.' };
            case 'usage':
                return { text: 'Hello!', usage: { inputTokens: 3, outputTokens: 2 } };
            case 'tool-error':
                return round === 0 ? { toolCalls: [{ name: 'failing', input: {}, id: 'f1' }] } : { text: 'It failed.' };
            case 'slow-tool':
                return round === 0 ? { toolCalls: [{ name: 'slow', input: {}, id: 's1' }] } : { text: 'never' };
            case 'model-error':
                return { error: 'the model is down' };
            case 'structured-output':
                return { text: '{"ok":true}' };
            case 'delegate-tree':
                return round === 0 ? { toolCalls: [{ name: 'delegate', input: {}, id: 'd1' }] } : { text: 'Done.' };
            case 'delegate-cancel':
                return round === 0 ? { toolCalls: [{ name: 'delegateSlow', input: {}, id: 'd1' }] } : { text: 'Moving on.' };
            case 'delegate-request':
                return round === 0 ? { toolCalls: [{ name: 'delegateAsking', input: {}, id: 'd1' }] } : { text: 'Done.' };
            case 'steer':
                return round === 0 ? { toolCalls: [{ name: 'delayed', input: {}, id: 't1' }] } : { text: 'Done.' };
            default:
                return { text: 'Hello!' };
        }
    };
}

/** Our engine never asks the client a question: those scenarios do not apply. */
const skip = (s: ConformanceScenario) => (s.name === 'input-request' || s.name === 'support-agent' ? 'modelAgent never emits input requests (no harness to ask)' : undefined);

describe('agentConformance: modelAgent(mockModel)', () => {
    // Two models, so the `configure` scenario has a switch to make: it needs a
    // `config` option with two or more values. The second never streams — the
    // suite switches to it after the turn — but it answers the same script so
    // that stays an implementation detail of the scenario, not of this file.
    const cases = agentConformance(
        (s) =>
            modelAgent({
                model: mockModel({ respond: respondFor(s) }),
                models: [mockModel({ respond: respondFor(s), modelId: 'mock-2' })]
            }),
        { capabilities: MODEL_AGENT_CAPABILITIES, skip }
    );
    it('skips only what the engine cannot do (no client questions, no session listing)', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual(['conformance: input-request', 'conformance: support-agent', 'conformance: list-sessions']);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
