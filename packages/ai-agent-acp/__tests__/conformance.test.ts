// @vitest-environment node
/** The conformance suite against the ACP adapter over the in-memory fake agent. */
import { describe, it, expect, afterEach } from 'vitest';
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';
import { acp, capabilitiesFrom } from '@sigx/ai-agent-acp';
import { fakeAcpAgent, FULL_CAPABILITIES, type FakeAcp, type FakePromptApi } from './fake-acp-agent';

const fakes: FakeAcp[] = [];
afterEach(async () => {
    for (const f of fakes.splice(0)) await f.close().catch(() => {});
});

const options = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'aa', name: 'Allow always', kind: 'allow_always' as const },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' as const }
];

/** What the fake agent does for each scenario. */
function behaviour(scenario: ConformanceScenario) {
    return async (api: FakePromptApi) => {
        switch (scenario.name) {
            case 'tool-permission':
            case 'headless-deny': {
                await api.toolCall({ toolCallId: 'g1', title: 'guarded', name: 'guarded', kind: 'other', status: 'pending', rawInput: {} });
                const outcome = await api.permission({ toolCall: { toolCallId: 'g1', title: 'guarded', name: 'guarded', rawInput: {} }, options });
                const allowed = outcome.outcome === 'selected' && outcome.optionId !== 'r1';
                await api.update({ sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: allowed ? 'completed' : 'failed', ...(allowed ? { rawOutput: { ok: true } } : {}) });
                await api.text(allowed ? 'Done.' : 'Not allowed.');
                return { stopReason: 'end_turn' as const };
            }
            case 'tool-error':
                await api.toolCall({ toolCallId: 'f1', title: 'failing', name: 'failing', kind: 'other', status: 'in_progress' });
                await api.update({ sessionUpdate: 'tool_call_update', toolCallId: 'f1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'the tool failed on purpose' } }] });
                await api.text('It failed.');
                return { stopReason: 'end_turn' as const };
            case 'slow-tool':
                await api.toolCall({ toolCallId: 's1', title: 'slow', name: 'slow', kind: 'execute', status: 'in_progress' });
                await api.untilCancelled();
                return { stopReason: 'cancelled' as const };
            case 'model-error': {
                const { JsonRpcError } = await import('@sigx/ai-agent/harness');
                throw new JsonRpcError(-32603, 'the model is down');
            }
            case 'usage':
                await api.text('Hello!');
                return { stopReason: 'end_turn' as const, usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 } };
            default:
                await api.text('Hello!');
                return { stopReason: 'end_turn' as const };
        }
    };
}

/** Every session the fake opens offers two modes, so `configure()` has something to switch. */
const modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'plan', name: 'Plan' }] };

describe('agentConformance: acp over a fake ACP agent', () => {
    const skip = (s: ConformanceScenario) => (s.name === 'input-request' || s.name === 'support-agent' ? 'ACP has no client input request in the subset this adapter speaks' : undefined);
    const make = async (s: ConformanceScenario) => {
        const fake = fakeAcpAgent({ onPrompt: behaviour(s), modes });
        fakes.push(fake);
        const agent = acp({ transport: fake.transport });
        await agent.connect();
        return agent;
    };
    // Capabilities are known only after connect(); the fake advertises FULL_CAPABILITIES, so the
    // same mapping `connect()` applies gives the suite its capability-driven skips up front —
    // a scenario the adapter cannot run is an asserted skip, never a silent no-op.
    const capabilities = capabilitiesFrom({ protocolVersion: 1, agentCapabilities: FULL_CAPABILITIES });
    const cases = agentConformance(make, { capabilities, skip, sessionOptions: { cwd: process.cwd() } });
    it('skips exactly the scenarios ACP cannot express', async () => {
        const probe = fakeAcpAgent({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
        fakes.push(probe);
        expect(await acp({ transport: probe.transport }).connect()).toEqual(capabilities);
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
            'conformance: input-request',
            'conformance: structured-output',
            'conformance: support-agent',
            'conformance: session-grant',
            'conformance: request-timeout',
            'conformance: portable-resume'
        ]);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
