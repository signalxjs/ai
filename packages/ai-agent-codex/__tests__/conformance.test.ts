// @vitest-environment node
/** The conformance suite against the Codex adapter over a scripted fake app-server. */
import { describe, it, expect } from 'vitest';
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';
import { codex, CODEX_CAPABILITIES } from '@sigx/ai-agent-codex';
import { fakeAppServer, say, type TurnProgram } from './fake-app-server';

/** What the fake Codex does for each scenario; the client tools come from the scenario. */
function programFor(scenario: ConformanceScenario): TurnProgram {
    const callTool = (tool: string, then: TurnProgram): TurnProgram => async (ctx) => {
        const id = `dyn_${tool}`;
        await ctx.item({ type: 'dynamicToolCall', id, namespace: null, tool, arguments: {}, status: 'inProgress', contentItems: null, success: null }, 'started');
        const r = await ctx.request<{ contentItems: { type: 'inputText'; text: string }[]; success: boolean }>('item/tool/call', { threadId: ctx.threadId, turnId: ctx.turnId, callId: id, namespace: null, tool, arguments: {} });
        if (ctx.isInterrupted()) {
            await ctx.item({ type: 'dynamicToolCall', id, namespace: null, tool, arguments: {}, status: 'failed', contentItems: null, success: false }, 'completed');
            await ctx.complete('interrupted');
            return;
        }
        await ctx.item({ type: 'dynamicToolCall', id, namespace: null, tool, arguments: {}, status: r.success ? 'completed' : 'failed', contentItems: r.contentItems, success: r.success }, 'completed');
        await then(ctx);
    };
    switch (scenario.name) {
        case 'tool-permission':
        case 'headless-deny':
            return callTool('guarded', say('Done.'));
        case 'tool-error':
            return callTool('failing', say('It failed.'));
        case 'slow-tool':
            return callTool('slow', say('never'));
        case 'model-error':
            return async (ctx) => ctx.complete('failed', { message: 'the model is down', codexErrorInfo: 'internalServerError', additionalDetails: null });
        case 'input-request':
            return async (ctx) => {
                await ctx.request('item/tool/requestUserInput', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'q', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'answer', header: 'Question', question: 'Yes or no?', isOther: true, isSecret: false, options: null }] });
                await say('Thanks.')(ctx);
            };
        case 'structured-output':
            return say('{"ok":true}');
        default:
            return say('Hello!');
    }
}

/** Codex has no handoff concept, so the non-coding support flow does not apply. */
const skip = (s: ConformanceScenario) => (s.name === 'support-agent' ? 'Codex emits no agent.handoff extension (its ext namespace is codex)' : undefined);

describe('agentConformance: codex(fake app-server)', () => {
    const cases = agentConformance((s) => codex({ transport: fakeAppServer({ onTurn: programFor(s) }).transport }), {
        capabilities: CODEX_CAPABILITIES,
        skip,
        sessionOptions: { cwd: '/repo' }
    });
    it('skips the every-call permission scenarios (Codex is harness-filtered) and the support-agent flow', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual(['conformance: tool-permission', 'conformance: headless-deny', 'conformance: support-agent']);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
