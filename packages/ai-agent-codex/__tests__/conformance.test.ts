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
        case 'steer':
            // The suite steers while the client tool runs; the adapter sends turn/steer and the fake accepts it for the active turn.
            return callTool('delayed', say('Done.'));
        case 'usage':
            return async (ctx) => {
                const last = { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 };
                await ctx.notify('thread/tokenUsage/updated', { threadId: ctx.threadId, turnId: ctx.turnId, tokenUsage: { total: last, last, modelContextWindow: 200_000 } });
                await say('Hello!')(ctx);
            };
        default:
            return say('Hello!');
    }
}

/**
 * Codex has no handoff concept, so the non-coding support flow does not apply; the fake lists one
 * fixed thread, never the ones it started; and a spawned sub-agent's own transcript (its child
 * thread) is not routed into the parent session until #100, so `delegate-tree` cannot see nested text.
 */
const skip = (s: ConformanceScenario) => {
    if (s.name === 'support-agent') return 'Codex emits no agent.handoff extension (its ext namespace is codex)';
    if (s.name === 'list-sessions') return 'the fake app-server answers thread/list with a fixed thread, not the ones it started';
    if (s.name === 'delegate-tree') return 'the child thread’s transcript is not routed into the parent session yet (#100)';
    return undefined;
};

describe('agentConformance: codex(fake app-server)', () => {
    const cases = agentConformance((s) => codex({ transport: fakeAppServer({ onTurn: programFor(s) }).transport }), {
        capabilities: CODEX_CAPABILITIES,
        skip,
        sessionOptions: { cwd: '/repo' }
    });
    it('skips the every-call permission scenarios (Codex is harness-filtered), portable resume, the support-agent flow, the fixed session listing and sub-agent control (observe only)', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
            'conformance: support-agent',
            'conformance: session-grant',
            'conformance: request-timeout',
            'conformance: list-sessions',
            'conformance: portable-resume',
            'conformance: delegate-tree',
            'conformance: delegate-cancel',
            'conformance: delegate-request'
        ]);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
