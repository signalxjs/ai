/** The conformance suite over the wire: a remote session must be indistinguishable from a local one. */
import { describe, it, expect } from 'vitest';
import type { Agent, AgentSession } from '@sigx/ai-agent';
import { serveSession, connectSession } from '@sigx/ai-agent/wire';
import { agentConformance, mockAgent, MOCK_CAPABILITIES, type ConformanceScenario, type MockStep } from '@sigx/ai-agent/testing';

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

/** A local agent whose every session is served and connected back through an in-memory transport. */
function remote(local: Agent): Agent {
    return {
        id: local.id,
        capabilities: local.capabilities,
        async session(options) {
            const session: AgentSession = await local.session(options);
            const served = serveSession(session, { agentId: local.id, capabilities: local.capabilities });
            return connectSession({ send: (c) => served.handleCommand(c), events: (from, o) => served.events(from, o) });
        },
        dispose: () => local.dispose()
    };
}

describe('agentConformance: connectSession(serveSession(mockAgent))', () => {
    const cases = agentConformance((s) => remote(mockAgent({ script: [scriptFor(s), scriptFor(s)] })), { capabilities: MOCK_CAPABILITIES });
    it('skips nothing', () => {
        expect(cases.filter((c) => c.skip)).toEqual([]);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
