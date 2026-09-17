// @vitest-environment node
/** The conformance suite against the Codex adapter over a scripted fake app-server. */
import { describe, it, expect } from 'vitest';
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';
import { codexCli, CODEX_CLI_CAPABILITIES } from '@sigx/ai-agent-codex-cli';
import { fakeAppServer, say, type TurnProgram } from './fake-app-server';

const activity = (id: string, kind: string, agentThreadId: string) => ({ type: 'subAgentActivity', id, kind, agentThreadId, agentPath: '/root/delegate' });

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
        case 'delegate-tree':
            // Codex 0.154: the spawn is a subAgentActivity "started" item; the child thread streams on the same connection.
            return async (ctx) => {
                await ctx.item(activity('call_delegate', 'started', 'child_d'), 'started');
                await ctx.item(activity('call_delegate', 'started', 'child_d'), 'completed');
                const child = await ctx.child('child_d').startTurn();
                await child.item({ type: 'agentMessage', id: 'cmsg_d', text: '' }, 'started');
                await child.delta('cmsg_d', 'Delegate reply.');
                await child.item({ type: 'agentMessage', id: 'cmsg_d', text: 'Delegate reply.' }, 'completed');
                await child.complete();
                await ctx.item(activity('done_d', 'completed', 'child_d'), 'completed');
                await say('Done.')(ctx);
            };
        case 'delegate-cancel':
            // The suite cancels the sub-agent on its first running update; the adapter interrupts the child turn.
            return async (ctx) => {
                await ctx.item(activity('call_slow', 'started', 'child_s'), 'started');
                await ctx.item(activity('call_slow', 'started', 'child_s'), 'completed');
                const child = await ctx.child('child_s').startTurn();
                await child.item({ type: 'agentMessage', id: 'cmsg_s', text: '' }, 'started');
                await child.interrupted;
                await child.complete('interrupted');
                await say('Done.')(ctx);
            };
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
 * Codex has no handoff concept, so the non-coding support flow does not apply; and the fake lists one
 * fixed thread, never the ones it started.
 */
const skip = (s: ConformanceScenario) => {
    if (s.name === 'support-agent') return 'Codex emits no agent.handoff extension (its ext namespace is codex)';
    if (s.name === 'list-sessions') return 'the fake app-server answers thread/list with a fixed thread, not the ones it started';
    return undefined;
};

describe('agentConformance: codexCli(fake app-server)', () => {
    const cases = agentConformance((s) => codexCli({ transport: fakeAppServer({ onTurn: programFor(s) }).transport }), {
        capabilities: CODEX_CLI_CAPABILITIES,
        skip,
        sessionOptions: { cwd: '/repo' }
    });
    it('skips the every-call permission scenarios (Codex is harness-filtered, the nested request one included), portable resume, streaming tool input, the support-agent flow and the fixed session listing', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual([
            'conformance: tool-permission',
            'conformance: headless-deny',
            'conformance: support-agent',
            'conformance: session-grant',
            'conformance: request-timeout',
            // The app-server protocol has no argument deltas: items are
            // announced whole.
            'conformance: streaming-tool-input',
            'conformance: list-sessions',
            'conformance: portable-resume',
            'conformance: delegate-request'
        ]);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});
