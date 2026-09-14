// @vitest-environment node
/** The conformance suite against the Copilot adapter over a scripted fake client. */
import { describe, it, expect } from 'vitest';
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';
import { copilot, COPILOT_CAPABILITIES } from '@sigx/ai-agent-copilot';
import { fakeClient, say, type TurnProgram } from './fake-client';

/** What the fake runtime does for each scenario; the client tools come from the scenario. */
function programFor(scenario: ConformanceScenario): TurnProgram {
    switch (scenario.name) {
        case 'tool-permission':
        case 'headless-deny':
        case 'session-grant':
        case 'request-timeout':
            return async (ctx) => {
                await ctx.callTool('guarded', {});
                if (scenario.name === 'session-grant') await ctx.callTool('guarded', {});
                await ctx.say('Done.');
            };
        case 'tool-error':
            return async (ctx) => {
                await ctx.callTool('failing', {});
                await ctx.say('It failed.');
            };
        case 'slow-tool':
            return async (ctx) => {
                await ctx.callTool('slow', {});
                await ctx.say('never');
            };
        case 'model-error':
            return (ctx) => ctx.error({ message: 'the model is down', statusCode: 500 });
        case 'input-request':
            return async (ctx) => {
                await ctx.askUser({ question: 'Yes or no?', choices: ['yes', 'no'] });
                await ctx.say('Thanks.');
            };
        case 'usage':
            return async (ctx) => {
                ctx.usage({ inputTokens: 3, outputTokens: 2 });
                await ctx.say('Hello!');
            };
        case 'delegate-tree':
            // The runtime reports the spawn, streams the child's own events under its agent id, and completes it.
            return async (ctx) => {
                ctx.emit('subagent.started', { toolCallId: 'call_delegate', agentName: 'delegate', agentDisplayName: 'Delegate', agentDescription: 'Does the task.' });
                await ctx.say('Delegate reply.', { agentId: 'sub_1' });
                ctx.emit('subagent.completed', { toolCallId: 'call_delegate', agentName: 'delegate', agentDisplayName: 'Delegate', totalTokens: 12 });
                await ctx.say('Done.');
            };
        default:
            return say('Hello!');
    }
}

/** Copilot has no handoff concept, so the non-coding support flow does not apply. */
const skip = (s: ConformanceScenario) => (s.name === 'support-agent' ? 'Copilot emits no agent.handoff extension (its ext namespace is copilot)' : undefined);

describe('agentConformance: copilot(fake client)', () => {
    const cases = agentConformance((s) => copilot({ client: fakeClient(programFor(s)).client, errorSettleMs: 20 }), {
        capabilities: COPILOT_CAPABILITIES,
        skip,
        sessionOptions: { cwd: '/repo' }
    });
    it('skips the every-call permission scenarios (Copilot is harness-filtered), structured output, fork, portable resume, the support-agent flow, sub-agent control and steering', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
            'conformance: structured-output',
            'conformance: support-agent',
            'conformance: session-grant',
            'conformance: request-timeout',
            'conformance: fork',
            'conformance: portable-resume',
            'conformance: delegate-cancel',
            'conformance: delegate-request',
            'conformance: steer'
        ]);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
