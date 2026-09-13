// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { allowAll, denyAll, createTranscript, createReducer, type AgentEvent, type Decision, type SessionRef } from '@sigx/ai-agent';
import { codingExtension, codingState } from '@sigx/ai-agent/coding';
import { resolveExecutable } from '@sigx/ai-agent-node';
import { codex, CODEX_CAPABILITIES, toErrorCode } from '@sigx/ai-agent-codex';
import { fakeAppServer, say, type TurnProgram } from './fake-app-server';

function schema<T>(check: (v: unknown) => v is T, json: JsonSchema): StandardSchemaV1<T, T> {
    return { '~standard': { version: 1, vendor: 'test', validate: (v) => (check(v) ? { value: v } : { issues: [{ message: 'invalid' }] }), jsonSchema: { input: () => json, output: () => json } } };
}
const anyObject = schema((v): v is Record<string, unknown> => typeof v === 'object' && v !== null, { type: 'object', additionalProperties: true });
const okSchema = schema((v): v is { ok: boolean } => typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean', { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });

const echo = defineTool({ name: 'echo', description: 'Echoes.', input: anyObject, execute: (input) => ({ echoed: input }) });
const failing = defineTool({
    name: 'failing',
    description: 'Throws.',
    input: anyObject,
    execute: () => {
        throw new Error('boom');
    }
});

async function drain(turn: AsyncIterable<AgentEvent> & { result: Promise<unknown> }, onEvent?: (e: AgentEvent, i: number) => Promise<void> | void) {
    const events: AgentEvent[] = [];
    for await (const e of turn) {
        events.push(e);
        if (onEvent) await onEvent(e, events.length - 1);
    }
    return { events, result: (await turn.result) as Awaited<typeof turn.result> };
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const textOf = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta').map((e) => e.delta).join('');
const updates = (events: AgentEvent[], callId?: string) => events.filter((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update' && (callId === undefined || e.callId === callId)).map((u) => u.status);

/** A command execution that asks for approval, streams output and completes. */
const shellProgram =
    (command: string): TurnProgram =>
    async (ctx) => {
        const id = 'cmd_1';
        await ctx.item({ type: 'commandExecution', id, command, cwd: '/repo', status: 'inProgress', aggregatedOutput: null, exitCode: null }, 'started');
        const { decision } = await ctx.request<{ decision: string }>('item/commandExecution/requestApproval', { kind: 'command', threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, command, cwd: '/repo', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
        if (decision === 'decline' || decision === 'cancel') {
            await ctx.item({ type: 'commandExecution', id, command, cwd: '/repo', status: 'declined', aggregatedOutput: null, exitCode: null }, 'completed');
            await ctx.notify('turn/completed_decision', { threadId: ctx.threadId, turnId: ctx.turnId, decision });
            await ctx.complete();
            return;
        }
        await ctx.notify('item/commandExecution/outputDelta', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, delta: 'hello ' });
        await ctx.notify('item/commandExecution/outputDelta', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: id, delta: 'world\n' });
        await ctx.item({ type: 'commandExecution', id, command, cwd: '/repo', status: 'completed', aggregatedOutput: 'hello world\n', exitCode: 0 }, 'completed');
        await ctx.notify('turn/completed_decision', { threadId: ctx.threadId, turnId: ctx.turnId, decision });
        await say('Done.')(ctx);
    };

describe('@sigx/ai-agent-codex', () => {
    it('declares its capabilities and performs the handshake once', async () => {
        const fake = fakeAppServer({ onTurn: say('Hello there') });
        const agent = codex({ transport: fake.transport, clientInfo: { name: 'test', version: '1.2.3' } });
        expect(agent.id).toBe('codex');
        expect(agent.capabilities).toEqual(CODEX_CAPABILITIES);
        const session = await agent.session({ cwd: '/repo' });
        expect(fake.requests.map((r) => r.method)).toEqual(['initialize', 'initialized', 'account/read', 'model/list', 'thread/start']);
        expect(fake.requests[0]!.params).toEqual({ clientInfo: { name: 'test', title: null, version: '1.2.3' }, capabilities: { experimentalApi: true, requestAttestation: false } });
        expect(fake.requests[4]!.params).toMatchObject({ cwd: '/repo', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
        expect(session.ref).toEqual({ agent: 'codex', v: 1, id: session.id, data: { cwd: '/repo', epoch: 1 } });
        const { events, result } = await drain(session.prompt('hi'));
        expect(types(events)).toEqual(['turn-start', 'user-message', 'ext', 'part-start', 'part-delta', 'part-delta', 'part-end', 'turn-end']);
        expect(events[2]).toMatchObject({ type: 'ext', ns: 'codex', name: 'turn', data: { turnId: expect.stringMatching(/^turn_/) } });
        expect(textOf(events)).toBe('Hello there');
        expect(result).toMatchObject({ stopReason: 'end_turn' });
        expect(fake.requests.at(-1)).toMatchObject({ method: 'turn/start', params: { threadId: session.id, input: [{ type: 'text', text: 'hi', text_elements: [] }] } });
        // A second session reuses the connection.
        await agent.session({ cwd: '/repo' });
        expect(fake.requests.filter((r) => r.method === 'initialize')).toHaveLength(1);
        await agent.dispose();
    });

    it('a policy makes the defaults strict; config is announced from model/list', async () => {
        const fake = fakeAppServer({ onTurn: say('x') });
        const agent = codex({ transport: fake.transport });
        const session = await agent.session({ cwd: '/repo', policy: allowAll, system: 'be terse', tools: [echo] });
        expect(fake.requests.at(-1)!.params).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', baseInstructions: 'be terse', dynamicTools: [{ type: 'function', name: 'echo', description: 'Echoes.' }] });
        const events: AgentEvent[] = [];
        for await (const e of session.subscribe({ epoch: 0, seq: 0 })) {
            events.push(e);
            if (e.type === 'config') break;
        }
        expect(events[0]).toMatchObject({ type: 'config', options: expect.arrayContaining([expect.objectContaining({ id: 'model', current: 'gpt-5', values: [{ id: 'gpt-5', label: 'GPT-5' }] }), expect.objectContaining({ id: 'approvalPolicy', current: 'untrusted' }), expect.objectContaining({ id: 'sandbox', current: 'workspace-write' })]) });
        await session.configure!({ model: 'gpt-5-mini', approvalPolicy: 'never' });
        await session.prompt('go').result;
        expect(fake.requests.at(-1)!.params).toMatchObject({ model: 'gpt-5-mini', approvalPolicy: 'never' });
        await agent.dispose();
    });

    it('not signed in → auth_required (account/read null, or getAuthStatus fallback)', async () => {
        const a = codex({ transport: fakeAppServer({ onTurn: say('x'), account: null }).transport });
        await expect(a.session({ cwd: '/repo' })).rejects.toMatchObject({ name: 'AgentError', code: 'auth_required' });
        const b = codex({ transport: fakeAppServer({ onTurn: say('x'), account: 'missing', authStatus: { authMethod: null, authToken: null, requiresOpenaiAuth: true } }).transport });
        await expect(b.session({ cwd: '/repo' })).rejects.toMatchObject({ code: 'auth_required' });
        const c = codex({ transport: fakeAppServer({ onTurn: say('x'), account: 'missing', authStatus: { authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true } }).transport });
        await expect(c.session({ cwd: '/repo' })).resolves.toBeDefined();
    });

    it('reasoning deltas and summaries become reasoning parts; unstreamed text is delivered at completion', async () => {
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.item({ type: 'reasoning', id: 'r1', summary: [], content: [] }, 'started');
                await ctx.notify('item/reasoning/summaryTextDelta', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'r1', delta: 'Plan', summaryIndex: 0 });
                await ctx.notify('item/reasoning/textDelta', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'r1', delta: 'think', contentIndex: 0 });
                await ctx.item({ type: 'reasoning', id: 'r1', summary: ['Planning'], content: ['thinking'] }, 'completed');
                await ctx.item({ type: 'agentMessage', id: 'm1', text: 'Answer without deltas' }, 'completed');
                await ctx.complete();
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const { events } = await drain(session.prompt('go'));
        const t = createTranscript(session.id);
        const reduce = createReducer();
        for (const e of events) reduce(t, e);
        const parts = t.messages.find((m) => m.role === 'assistant')!.parts;
        expect(parts).toEqual([
            { type: 'reasoning', id: 'r1:s0', text: 'Planning', done: true },
            { type: 'reasoning', id: 'r1:c0', text: 'thinking', done: true },
            { type: 'text', id: 'm1', text: 'Answer without deltas' }
        ]);
    });

    it('command execution: approval through the policy, output deltas → coding.terminal, exit → terminal-exit', async () => {
        const fake = fakeAppServer({ onTurn: shellProgram('ls -la') });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const turn = session.prompt('list');
        const { events, result } = await drain(turn, async (e) => {
            if (e.type === 'request') {
                expect(e).toMatchObject({ kind: 'permission', toolName: 'shell', callId: 'cmd_1', permissionKey: 'shell:ls -la' });
                await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
            }
        });
        expect(events.find((e) => e.type === 'tool-call')).toMatchObject({ callId: 'cmd_1', name: 'shell', category: 'execute', input: { command: 'ls -la', cwd: '/repo' } });
        expect(updates(events, 'cmd_1')).toEqual(['pending', 'in_progress', 'completed']);
        expect(events.find((e) => e.type === 'ext' && e.name === 'turn/completed_decision')).toMatchObject({ data: { decision: 'acceptForSession' } });
        const t = createTranscript(session.id);
        const reduce = createReducer({ extensions: [codingExtension()] });
        for (const e of events) reduce(t, e);
        expect(codingState(t)!.terminals.cmd_1).toEqual({ output: 'hello world\n', truncated: false, exitCode: 0 });
        expect(result).toMatchObject({ stopReason: 'end_turn' });
        expect(textOf(events)).toBe('Done.');
    });

    it('approval decisions map onto accept / acceptForSession (when offered) / decline / cancel', async () => {
        const decide = async (decision: Decision, available?: string[]) => {
            const fake = fakeAppServer({
                onTurn: async (ctx) => {
                    const r = await ctx.request<{ decision: string }>('item/commandExecution/requestApproval', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'c', command: 'x', availableDecisions: available ?? null });
                    await ctx.notify('turn/completed_decision', { threadId: ctx.threadId, turnId: ctx.turnId, decision: r.decision });
                    await ctx.complete();
                }
            });
            const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
            const { events } = await drain(session.prompt('go'), async (e) => {
                if (e.type === 'request') await session.respond(e.requestId, decision);
            });
            return (events.find((e) => e.type === 'ext' && e.name === 'turn/completed_decision') as { data: { decision: string } }).data.decision;
        };
        expect(await decide({ type: 'permission', outcome: 'allow', scope: 'once' })).toBe('accept');
        expect(await decide({ type: 'permission', outcome: 'allow', scope: 'session' })).toBe('acceptForSession');
        expect(await decide({ type: 'permission', outcome: 'allow', scope: 'session' }, ['accept', 'decline'])).toBe('accept');
        expect(await decide({ type: 'permission', outcome: 'deny', scope: 'once' })).toBe('decline');
        expect(await decide({ type: 'cancel' })).toBe('cancel');
        // A headless session with no policy declines without asking.
        const fake = fakeAppServer({ onTurn: shellProgram('rm -rf /') });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo', interactive: false });
        const { events } = await drain(session.prompt('go'));
        expect(events.filter((e) => e.type === 'request')).toHaveLength(0);
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'deny', by: 'policy' });
        expect(updates(events, 'cmd_1')).toEqual(['pending', 'in_progress', 'denied']);
    });

    it('file changes: patch updates → coding.diff, completion → files-changed and tool status', async () => {
        const changes = [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '--- a\n+++ b\n' }, { path: 'src/new.ts', kind: { type: 'add' }, diff: '+++ new\n' }];
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.item({ type: 'fileChange', id: 'fc1', changes: [], status: 'inProgress' }, 'started');
                const { decision } = await ctx.request<{ decision: string }>('item/fileChange/requestApproval', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'fc1', reason: 'edit files' });
                expect(decision).toBe('accept');
                await ctx.notify('item/fileChange/patchUpdated', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'fc1', changes });
                await ctx.item({ type: 'fileChange', id: 'fc1', changes, status: 'completed' }, 'completed');
                await ctx.complete();
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo', policy: allowAll });
        const { events } = await drain(session.prompt('edit'));
        expect(events.find((e) => e.type === 'tool-call')).toMatchObject({ callId: 'fc1', name: 'apply_patch', category: 'edit' });
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'allow', by: 'policy', ruleId: 'allowAll' });
        const diffs = events.filter((e) => e.type === 'ext' && e.name === 'diff');
        expect(diffs).toHaveLength(2);
        expect(diffs[0]).toMatchObject({ ns: 'coding', parentCallId: 'fc1', data: { path: 'src/a.ts', unifiedDiff: '--- a\n+++ b\n' } });
        expect(events.find((e) => e.type === 'ext' && e.name === 'files-changed')).toMatchObject({ data: { paths: ['src/a.ts', 'src/new.ts'] } });
        expect(updates(events, 'fc1')).toEqual(['pending', 'in_progress', 'completed']);
    });

    it('dynamic tool calls run the client tool through the policy; failures and denials come back as success: false', async () => {
        const calls: unknown[] = [];
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                for (const [id, tool] of [['d1', 'echo'], ['d2', 'failing'], ['d3', 'missing']] as const) {
                    await ctx.item({ type: 'dynamicToolCall', id, namespace: null, tool, arguments: { a: 1 }, status: 'inProgress', contentItems: null, success: null }, 'started');
                    const r = await ctx.request<{ contentItems: { text: string }[]; success: boolean }>('item/tool/call', { threadId: ctx.threadId, turnId: ctx.turnId, callId: id, namespace: null, tool, arguments: { a: 1 } });
                    calls.push(r);
                    await ctx.item({ type: 'dynamicToolCall', id, namespace: null, tool, arguments: { a: 1 }, status: r.success ? 'completed' : 'failed', contentItems: r.contentItems.map((c) => ({ type: 'inputText', text: c.text })), success: r.success }, 'completed');
                }
                await ctx.complete();
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo', tools: [echo, failing], policy: allowAll });
        const { events } = await drain(session.prompt('go'));
        expect(calls).toEqual([
            { contentItems: [{ type: 'inputText', text: '{"echoed":{"a":1}}' }], success: true },
            { contentItems: [{ type: 'inputText', text: 'boom' }], success: false },
            { contentItems: [{ type: 'inputText', text: 'Unknown tool "missing".' }], success: false }
        ]);
        expect(updates(events, 'd1')).toEqual(['pending', 'in_progress', 'completed']);
        expect(updates(events, 'd2')).toEqual(['pending', 'in_progress', 'failed']);
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'd1' && e.status === 'completed')).toMatchObject({ output: '{"echoed":{"a":1}}' });
        expect(events.filter((e) => e.type === 'request-resolved')).toHaveLength(2);

        const denying = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.item({ type: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'echo', arguments: {}, status: 'inProgress', contentItems: null, success: null }, 'started');
                const r = await ctx.request<{ success: boolean }>('item/tool/call', { threadId: ctx.threadId, turnId: ctx.turnId, callId: 'd1', namespace: null, tool: 'echo', arguments: {} });
                await ctx.item({ type: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'echo', arguments: {}, status: 'failed', contentItems: null, success: r.success }, 'completed');
                await ctx.complete();
            }
        });
        const s2 = await codex({ transport: denying.transport }).session({ cwd: '/repo', tools: [echo], policy: denyAll });
        const r2 = await drain(s2.prompt('go'));
        expect(updates(r2.events, 'd1')).toEqual(['pending', 'denied']);
    });

    it('user input requests become input requests and the answers travel back per question', async () => {
        let answers: unknown;
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                answers = await ctx.request('item/tool/requestUserInput', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'q', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'region', header: 'Region', question: 'Which region?', isOther: false, isSecret: false, options: [{ label: 'eu', description: 'Europe' }, { label: 'us', description: 'US' }] }, { id: 'note', header: 'Note', question: 'Anything else?', isOther: true, isSecret: false, options: null }] });
                await say('Thanks.')(ctx);
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const { events } = await drain(session.prompt('deploy'), async (e) => {
            if (e.type === 'request') {
                expect(e).toMatchObject({ kind: 'input', schema: { type: 'object', properties: { region: { enum: ['eu', 'us'] }, note: { type: 'string' } }, required: ['region', 'note'] } });
                await session.respond(e.requestId, { type: 'input', answers: { region: 'eu', note: ['a', 'b'] } });
            }
        });
        expect(answers).toEqual({ answers: { region: { answers: ['eu'] }, note: { answers: ['a', 'b'] } } });
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'input', by: 'client' });
    });

    it('cancel() interrupts; Codex completing the turn as interrupted ends it cancelled', async () => {
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.item({ type: 'commandExecution', id: 'slow', command: 'sleep 100', cwd: '/repo', status: 'inProgress', aggregatedOutput: null, exitCode: null }, 'started');
                await ctx.interrupted;
                await ctx.item({ type: 'commandExecution', id: 'slow', command: 'sleep 100', cwd: '/repo', status: 'failed', aggregatedOutput: null, exitCode: null }, 'completed');
                await ctx.complete('interrupted');
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo', policy: allowAll });
        const turn = session.prompt('go');
        const { events, result } = await drain(turn, async (e) => {
            if (e.type === 'tool-update' && e.status === 'in_progress') await session.cancel();
        });
        expect(fake.requests.find((r) => r.method === 'turn/interrupt')).toBeDefined();
        expect(result).toMatchObject({ stopReason: 'cancelled' });
        expect(updates(events, 'slow').at(-1)).toMatch(/failed|cancelled/);
    });

    it('failed turns carry the error code; error notifications with willRetry are recoverable', async () => {
        const cases: [unknown, string][] = [
            ['contextWindowExceeded', 'context_exceeded'],
            ['rateLimitExceeded', 'rate_limited'],
            ['usageLimitExceeded', 'rate_limited'],
            ['serverOverloaded', 'rate_limited'],
            ['unauthorized', 'auth_required'],
            ['badRequest', 'provider_error'],
            [{ httpConnectionFailed: { httpStatusCode: 502 } }, 'provider_error'],
            [null, 'provider_error']
        ];
        for (const [info, code] of cases) expect(toErrorCode(info as never)).toBe(code);
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.notify('error', { threadId: ctx.threadId, turnId: ctx.turnId, error: { message: 'retrying', codexErrorInfo: 'serverOverloaded' }, willRetry: true });
                await ctx.complete('failed', { message: 'the context is full', codexErrorInfo: 'contextWindowExceeded', additionalDetails: null });
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const { events, result } = await drain(session.prompt('go'));
        expect(events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ code: 'rate_limited', recoverable: true, message: 'retrying' }), expect.objectContaining({ code: 'context_exceeded', recoverable: false })]);
        expect(result).toMatchObject({ stopReason: 'error', error: { code: 'context_exceeded', message: 'the context is full' } });
    });

    it('structured output: outputSchema goes to Codex and the final message is validated onto turn-end.output', async () => {
        const fake = fakeAppServer({ onTurn: (ctx) => say(ctx.params.outputSchema ? '{"ok":true}' : 'plain')(ctx) });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const r1 = await session.prompt('go', { output: { schema: okSchema } }).result;
        expect(r1).toMatchObject({ stopReason: 'end_turn', output: { ok: true } });
        expect(fake.requests.at(-1)!.params).toMatchObject({ outputSchema: { type: 'object', required: ['ok'] } });
        const r2 = await session.prompt('go', { output: { schema: { type: 'object' } } }).result;
        expect(r2.output).toEqual({ ok: true });
        const bad = fakeAppServer({ onTurn: say('{"ok":"nope"}') });
        const s2 = await codex({ transport: bad.transport }).session({ cwd: '/repo' });
        const r3 = await drain(s2.prompt('go', { output: { schema: okSchema } }));
        expect(r3.result).toMatchObject({ stopReason: 'error', error: { code: 'provider_error' } });
        expect(r3.events.at(-2)).toMatchObject({ type: 'error', message: expect.stringContaining('did not match') });
    });

    it('token usage, plans, turn diffs, rate limits and unknown items pass through', async () => {
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.notify('turn/plan/updated', { threadId: ctx.threadId, turnId: ctx.turnId, explanation: null, plan: [{ step: 'read', status: 'completed' }, { step: 'write', status: 'inProgress' }] });
                await ctx.notify('turn/diff/updated', { threadId: ctx.threadId, turnId: ctx.turnId, diff: '--- x' });
                await ctx.notify('account/rateLimits/updated', { rateLimits: { limitId: null } });
                await ctx.item({ type: 'contextCompaction', id: 'cc1' }, 'completed');
                await ctx.notify('thread/tokenUsage/updated', { threadId: ctx.threadId, turnId: ctx.turnId, tokenUsage: { total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 }, last: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, modelContextWindow: 200000 } });
                await say('ok')(ctx);
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const { events, result } = await drain(session.prompt('go'));
        expect(events.find((e) => e.type === 'ext' && e.ns === 'coding' && e.name === 'plan')).toMatchObject({ data: { entries: [{ content: 'read', status: 'completed' }, { content: 'write', status: 'in_progress' }] } });
        expect(events.find((e) => e.type === 'ext' && e.name === 'turn-diff')).toMatchObject({ ns: 'codex', data: { diff: '--- x' } });
        expect(events.find((e) => e.type === 'ext' && e.name === 'account/rateLimits/updated')).toMatchObject({ ns: 'codex' });
        expect(events.find((e) => e.type === 'ext' && e.name === 'item.contextCompaction')).toMatchObject({ ns: 'codex', data: { phase: 'completed' } });
        const usages = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
        expect(usages.map((u) => [u.scope, u.usage.inputTokens, u.usage.totalTokens])).toEqual([
            ['turn', 2, 3],
            ['session', 20, 30]
        ]);
        // Codex's own spellings are reported under the well-known `Usage`
        // keys every adapter shares.
        expect(usages.map((u) => u.usage.reasoningTokens)).toEqual([0, 2]);
        expect(usages.map((u) => [u.usage.cacheReadInputTokens, u.usage.cacheCreationInputTokens])).toEqual([
            [0, 0],
            [5, 0]
        ]);
        expect(result).toMatchObject({ usage: { inputTokens: 2, outputTokens: 1 } });
        for (const e of events) expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    });

    it('resume opens a new epoch on the same thread; fork starts a new one; listSessions maps threads', async () => {
        const fake = fakeAppServer({ onTurn: say('x'), threadId: 'thread_fixed' });
        const agent = codex({ transport: fake.transport });
        const s1 = await agent.session({ cwd: '/repo' });
        const r1 = await drain(s1.prompt('a'));
        expect(r1.events[0]!.epoch).toBe(1);
        const ref = s1.ref;
        await s1.close();
        const s2 = await agent.session({ cwd: '/repo', resume: ref });
        expect(s2.id).toBe('thread_fixed');
        expect(fake.threads.at(-1)).toMatchObject({ method: 'thread/resume', params: { threadId: 'thread_fixed', cwd: '/repo' } });
        const r2 = await drain(s2.prompt('b'));
        expect(r2.events[0]!.epoch).toBe(2);
        const s3 = await agent.session({ cwd: '/repo', resume: ref, fork: true });
        expect(s3.id).toBe('thread_fixed-fork');
        expect(fake.threads.at(-1)!.method).toBe('thread/fork');
        await expect(agent.session({ cwd: '/repo', resume: { agent: 'other', v: 1, id: 'x' } })).rejects.toThrow(/belongs to agent/);
        expect(await agent.listSessions!()).toEqual([{ ref: { agent: 'codex', v: 1, id: 'thread_a', data: { cwd: '/repo' } }, title: 'First thread' }]);
        await agent.dispose();
    });

    it('the ref carries the epoch, so successive resumes from a persisted ref keep advancing it', async () => {
        const fake = fakeAppServer({ onTurn: say('x'), threadId: 'thread_fixed' });
        const agent = codex({ transport: fake.transport });
        // A caller persists `session.ref` verbatim (JSON round-trip) and resumes from what it stored.
        const persist = (ref: SessionRef): SessionRef => JSON.parse(JSON.stringify(ref)) as SessionRef;
        const s1 = await agent.session({ cwd: '/repo' });
        expect((await drain(s1.prompt('a'))).events[0]!.epoch).toBe(1);
        const ref1 = persist(s1.ref);
        expect(ref1.data).toEqual({ cwd: '/repo', epoch: 1 });
        await s1.close();
        const s2 = await agent.session({ cwd: '/repo', resume: ref1 });
        expect((await drain(s2.prompt('b'))).events[0]!.epoch).toBe(2);
        const ref2 = persist(s2.ref);
        expect(ref2.data).toEqual({ cwd: '/repo', epoch: 2 });
        await s2.close();
        const s3 = await agent.session({ cwd: '/repo', resume: ref2 });
        expect((await drain(s3.prompt('c'))).events[0]!.epoch).toBe(3);
        await agent.dispose();
    });

    it('the connection closing under a running turn ends it with process_exited', async () => {
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.item({ type: 'agentMessage', id: 'm', text: '' }, 'started');
                await fake.close();
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const { result } = await drain(session.prompt('go'));
        expect(result).toMatchObject({ stopReason: 'error', error: { code: 'process_exited' } });
    });

    it('rejects prompts without a cwd and unsupported prompt parts', async () => {
        const fake = fakeAppServer({ onTurn: say('x') });
        const agent = codex({ transport: fake.transport });
        await expect(agent.session({} as never)).rejects.toThrow(/cwd/);
        const session = await agent.session({ cwd: '/repo' });
        const r = await drain(session.prompt([{ type: 'file', mediaType: 'application/pdf', data: 'AA==' }]));
        expect(r.result).toMatchObject({ stopReason: 'error', error: { code: 'protocol_error' } });
    });

    it('an npm codex.cmd shim resolves to bin/codex.js under process.execPath (Windows shape)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'sigx-codex-shim-'));
        try {
            const pkg = join(dir, 'node_modules', '@openai', 'codex', 'bin');
            mkdirp(pkg);
            writeFileSync(join(pkg, 'codex.js'), '// launcher\n');
            writeFileSync(join(dir, 'codex.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
            const exe = await resolveExecutable('codex', { platform: 'win32', env: { Path: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, nodePath: 'C:\\node\\node.exe' });
            expect(exe.kind).toBe('node-script');
            expect(exe.command).toBe('C:\\node\\node.exe');
            expect(exe.args[0]).toMatch(/codex\.js$/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

function mkdirp(dir: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').mkdirSync(dir, { recursive: true });
}

/** Live smoke — needs a signed-in Codex CLI on PATH and SIGX_LIVE_CODEX=1. */
const liveReason = process.env.SIGX_LIVE_CODEX ? undefined : 'SIGX_LIVE_CODEX is not set';
describe.skipIf(!!liveReason)('@sigx/ai-agent-codex (live)', () => {
    it('answers a short prompt', async () => {
        const agent = codex();
        const session = await agent.session({ cwd: tmpdir(), interactive: false, policy: allowAll });
        const turn = session.prompt('Reply with the single word: pong');
        let text = '';
        for await (const e of turn) if (e.type === 'part-delta') text += e.delta;
        const result = await turn.result;
        expect(result.stopReason).toBe('end_turn');
        expect(text.toLowerCase()).toContain('pong');
        await agent.dispose();
    }, 120_000);
});
if (liveReason) console.log(`[ai-agent-codex] live smoke skipped: ${liveReason}`);
