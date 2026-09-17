// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { defineTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { allowAll, denyAll, createTranscript, createReducer, type AgentEvent, type AgentSession, type AgentTurn, type SessionRef } from '@sigx/ai-agent';
import { codingExtension, codingState } from '@sigx/ai-agent/coding';
import { checkEventInvariants } from '@sigx/ai-agent/testing';
import { copilotCli, COPILOT_CLI_CAPABILITIES, COPILOT_CLI_NS, configOptions, toClientOptions, toErrorCode, toPolicyRequest, toCopilotDecision, answerText, toModelValues, toUsage } from '@sigx/ai-agent-copilot-cli';
import { fakeClient, say, MODELS, type TurnProgram, type FakeClientOptions } from './fake-client';

function schema<T>(check: (v: unknown) => v is T, json: JsonSchema): StandardSchemaV1<T, T> {
    return { '~standard': { version: 1, vendor: 'test', validate: (v) => (check(v) ? { value: v } : { issues: [{ message: 'invalid' }] }), jsonSchema: { input: () => json, output: () => json } } };
}
const anyObject = schema((v): v is Record<string, unknown> => typeof v === 'object' && v !== null, { type: 'object', additionalProperties: true });

const echo = defineTool({ name: 'echo', description: 'Echoes.', input: anyObject, execute: (input) => ({ echoed: input }) });
const failing = defineTool({
    name: 'failing',
    description: 'Throws.',
    input: anyObject,
    execute: () => {
        throw new Error('boom');
    }
});

async function drain(turn: AgentTurn, onEvent?: (e: AgentEvent, i: number) => Promise<void> | void) {
    const events: AgentEvent[] = [];
    for await (const e of turn) {
        events.push(e);
        if (onEvent) await onEvent(e, events.length - 1);
    }
    return { events, result: await turn.result };
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const textOf = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta').map((e) => e.delta).join('');
const updates = (events: AgentEvent[], callId?: string) => events.filter((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update' && (callId === undefined || e.callId === callId)).map((u) => u.status);
const configOf = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'config' }> => e.type === 'config');

/** An agent over a fake, with the session-level events collected from the start. */
async function open(program: TurnProgram, options: { fake?: FakeClientOptions; session?: Record<string, unknown>; agent?: Record<string, unknown> } = {}) {
    const fake = fakeClient(program, options.fake);
    const agent = copilotCli({ client: fake.client, errorSettleMs: 20, ...options.agent });
    const session = await agent.session({ cwd: '/repo', interactive: false, policy: allowAll, ...options.session });
    const all: AgentEvent[] = [];
    const sub = session.subscribe({ epoch: 0, seq: 0 });
    const reading = (async () => {
        for await (const e of sub) all.push(e);
    })();
    const settle = async () => reading;
    /** Close the session and check the whole log's invariants. */
    const finish = async () => {
        await session.close();
        await settle();
        checkEventInvariants(all);
        return all;
    };
    return { fake, agent, session, all, settle, finish };
}

describe('@sigx/ai-agent-copilot-cli', () => {
    it('advertises its capabilities', () => {
        expect(copilotCli().capabilities).toEqual(COPILOT_CLI_CAPABILITIES);
        expect(COPILOT_CLI_CAPABILITIES).toMatchObject({ resume: 'local', fork: false, cancel: true, steer: false, config: true, tools: 'native', permissions: 'harness-filtered', subagents: 'observe', defineAgents: true, promptParts: 'text' });
        expect(copilotCli({ id: 'cp2' }).id).toBe('cp2');
    });

    it('needs a cwd, and refuses a ref of another agent and a fork', async () => {
        const { client } = fakeClient(say('hi'));
        const agent = copilotCli({ client });
        await expect(agent.session({} as never)).rejects.toMatchObject({ code: 'protocol_error' });
        await expect(agent.session({ cwd: '/repo', resume: { agent: 'codex-cli', v: 1, id: 'x' } })).rejects.toMatchObject({ code: 'protocol_error' });
        await expect(agent.session({ cwd: '/repo', resume: { agent: 'copilot-cli', v: 1, id: 'x' }, fork: true })).rejects.toMatchObject({ code: 'protocol_error' });
    });

    it('streams a text reply as parts, ends the turn at session.idle, and the user message comes first', async () => {
        const { session, fake, finish } = await open(say('Hello there.'));
        const { events, result } = await drain(session.prompt('Hi'));
        expect(result).toMatchObject({ stopReason: 'end_turn' });
        expect(types(events).slice(0, 3)).toEqual(['turn-start', 'user-message', 'part-start']);
        expect(textOf(events)).toBe('Hello there.');
        expect(types(events).at(-1)).toBe('turn-end');
        expect(fake.sessions[0]!.sends).toEqual(['Hi']);
        expect(fake.sessions[0]!.config).toMatchObject({ workingDirectory: '/repo', streaming: true });
        await finish();
    });

    it('creates the SDK session with our own id, so events during creation reach the session', async () => {
        const { session, fake, all, settle } = await open(say('x'));
        expect(fake.sessions[0]!.sessionId).toBe(session.id);
        expect(session.id).toMatch(/^cp_/);
        expect(session.ref).toEqual({ agent: 'copilot-cli', v: 1, id: session.id, data: { cwd: '/repo', epoch: 1 } });
        await session.close();
        await settle();
        // `session.start` arrived before `createSession` resolved and still produced the config.
        expect(configOf(all)).toHaveLength(1);
    });

    it('delivers the whole message when nothing was streamed, and only the remainder otherwise', async () => {
        const { session } = await open(async (ctx) => {
            await ctx.say('unstreamed', { deltas: false });
            const id = 'm2';
            ctx.emit('assistant.message_delta', { messageId: id, deltaContent: 'par' });
            ctx.emit('assistant.message', { messageId: id, content: 'partial' });
        });
        const { events } = await drain(session.prompt('go'));
        const deltas = events.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta').map((e) => e.delta);
        expect(deltas).toEqual(['unstreamed', 'par', 'tial']);
        const starts = events.filter((e): e is Extract<AgentEvent, { type: 'part-start' }> => e.type === 'part-start');
        expect(starts.map((s) => s.messageId)).toEqual([`a:${events[0]!.turnId}:0`, `a:${events[0]!.turnId}:1`]);
    });

    it('maps reasoning deltas and the complete reasoning to reasoning parts', async () => {
        const { session, finish } = await open(async (ctx) => {
            ctx.reason('thinking hard');
            await ctx.say('Done.');
        });
        const { events } = await drain(session.prompt('go'));
        const reasoning = events.filter((e): e is Extract<AgentEvent, { type: 'part-start' }> => e.type === 'part-start' && e.kind === 'reasoning');
        expect(reasoning).toHaveLength(1);
        const partId = reasoning[0]!.partId;
        const text = events.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta' && e.partId === partId).map((e) => e.delta).join('');
        expect(text).toBe('thinking hard');
        await finish();
    });

    describe('client tools', () => {
        it('declares them on the session from the spec and runs them through the SDK handler', async () => {
            const { session, fake, finish } = await open(
                async (ctx) => {
                    const r = await ctx.callTool('echo', { a: 1 });
                    expect(r).toMatchObject({ resultType: 'success', textResultForLlm: JSON.stringify({ echoed: { a: 1 } }) });
                    await ctx.say('Echoed.');
                },
                { session: { tools: [echo] } }
            );
            const declared = fake.sessions[0]!.config.tools!;
            expect(declared.map((t) => t.name)).toEqual(['echo']);
            expect(declared[0]!.parameters).toEqual(echo.spec.inputSchema);
            const { events, result } = await drain(session.prompt('use echo'));
            expect(result).toMatchObject({ stopReason: 'end_turn' });
            const call = events.find((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call')!;
            expect(call).toMatchObject({ name: 'echo', input: { a: 1 } });
            expect(updates(events, call.callId)).toEqual(['pending', 'in_progress', 'completed']);
            const done = events.find((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update' && e.status === 'completed')!;
            expect(done.output).toEqual({ echoed: { a: 1 } });
            await finish();
        });

        it('asks the policy once — through the runtime’s custom-tool permission — and a denial reads denied', async () => {
            const asked: string[] = [];
            const { session } = await open(
                async (ctx) => {
                    await ctx.callTool('echo', {});
                    await ctx.say('Blocked.');
                },
                { session: { tools: [echo], policy: (req: { toolName?: string }) => (asked.push(req.toolName!), { type: 'permission', outcome: 'deny', scope: 'once', message: 'nope' }) } }
            );
            const { events, result } = await drain(session.prompt('use echo'));
            expect(result).toMatchObject({ stopReason: 'end_turn' });
            expect(asked).toEqual(['echo']);
            expect(updates(events)).toEqual(['pending', 'denied']);
            expect(events.find((e) => e.type === 'tool-update' && e.status === 'denied')).toMatchObject({ error: 'nope' });
            expect(events.find((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved')).toMatchObject({ outcome: 'deny' });
        });

        it('asks the policy itself when the runtime skipped the ask, and a session grant is offered as approve-for-session', async () => {
            const asked: unknown[] = [];
            const { session, fake } = await open(
                async (ctx) => {
                    await ctx.callTool('echo', { n: 1 }, { skipAsk: true });
                    // A native ask, allowed for the session by the policy.
                    const d = await ctx.ask({ kind: 'shell', fullCommandText: 'ls', intention: 'list', commands: [], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true, toolCallId: 'sh1' });
                    asked.push(d);
                    await ctx.say('ok');
                },
                { session: { tools: [echo], policy: () => ({ type: 'permission', outcome: 'allow', scope: 'session' }) } }
            );
            const { events } = await drain(session.prompt('go'));
            // The policy answered both without a client, so only the resolutions show.
            const resolved = events.filter((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved');
            expect(resolved.map((r) => [r.outcome, r.scope, r.by])).toEqual([['allow', 'session', 'policy'], ['allow', 'session', 'policy']]);
            expect(asked).toEqual([{ kind: 'approve-for-session' }]);
            const call = events.find((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call' && e.name === 'echo')!;
            expect(updates(events, call.callId)).toEqual(['pending', 'in_progress', 'completed']);
            expect(fake.sessions[0]!.config.tools!.map((t) => t.name)).toEqual(['echo']);
        });

        it('reports a throwing tool as failed and the turn still ends normally', async () => {
            const { session } = await open(
                async (ctx) => {
                    const r = await ctx.callTool('failing', {});
                    expect(r).toMatchObject({ resultType: 'failure', error: 'boom' });
                    await ctx.say('It failed.');
                },
                { session: { tools: [failing] } }
            );
            const { events, result } = await drain(session.prompt('go'));
            expect(result).toMatchObject({ stopReason: 'end_turn' });
            expect(updates(events)).toEqual(['pending', 'in_progress', 'failed']);
            expect(events.find((e) => e.type === 'tool-update' && e.status === 'failed')).toMatchObject({ error: 'boom' });
        });

        it('a headless session with no policy denies the tool', async () => {
            const { session } = await open(
                async (ctx) => {
                    await ctx.callTool('echo', {});
                    await ctx.say('ok');
                },
                { session: { tools: [echo], policy: undefined } }
            );
            const { events, result } = await drain(session.prompt('go'));
            expect(result).toMatchObject({ stopReason: 'end_turn' });
            expect(updates(events)).toEqual(['pending', 'denied']);
        });
    });

    describe('permissions', () => {
        it('maps every kind of ask onto a policy request with a stable permissionKey', () => {
            const shell = toPolicyRequest({ kind: 'shell', fullCommandText: 'rm -rf x', intention: 'clean', commands: [], possiblePaths: ['x'], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true, toolCallId: 'c1' });
            expect(shell).toMatchObject({ kind: 'permission', callId: 'c1', toolName: 'shell', category: 'execute', source: 'native', permissionKey: 'shell:rm -rf x', input: { command: 'rm -rf x', paths: ['x'] } });
            expect(toPolicyRequest({ kind: 'write', fileName: 'a.ts', diff: '+1', intention: 'edit', canOfferSessionApproval: false })).toMatchObject({ toolName: 'write', category: 'edit', permissionKey: 'write:a.ts', input: { path: 'a.ts', diff: '+1' } });
            expect(toPolicyRequest({ kind: 'read', path: '/etc/hosts', intention: 'look' })).toMatchObject({ toolName: 'read', category: 'read', permissionKey: 'read:/etc/hosts' });
            expect(toPolicyRequest({ kind: 'url', url: 'https://x.y', intention: 'fetch' })).toMatchObject({ toolName: 'fetch', category: 'fetch', permissionKey: 'fetch:https://x.y' });
            expect(toPolicyRequest({ kind: 'mcp', serverName: 'gh', toolName: 'issues', toolTitle: 'List issues', readOnly: true, args: { q: 1 } })).toMatchObject({ toolName: 'gh/issues', source: 'mcp', annotations: { readOnly: true }, input: { q: 1 }, permissionKey: 'mcp:gh/issues' });
            expect(toPolicyRequest({ kind: 'custom-tool', toolName: 'echo', toolDescription: 'Echoes.', args: {} })).toMatchObject({ toolName: 'echo', source: 'client', permissionKey: 'tool:echo' });
            expect(toPolicyRequest({ kind: 'memory', fact: 'likes tabs' })).toMatchObject({ toolName: 'memory', category: 'other', permissionKey: 'memory' });
            expect(toPolicyRequest({ kind: 'hook', toolName: 'lint', hookMessage: 'run lint' })).toMatchObject({ toolName: 'lint', category: 'other', message: 'run lint' });
            expect(toPolicyRequest({ kind: 'factory' } as never)).toMatchObject({ toolName: 'factory', category: 'other' });
        });

        it('turns decisions into Copilot’s: once, for the session (only when offered), reject with feedback, cancel', () => {
            expect(toCopilotDecision({ type: 'permission', outcome: 'allow', scope: 'once' })).toEqual({ kind: 'approve-once' });
            expect(toCopilotDecision({ type: 'permission', outcome: 'allow', scope: 'session' })).toEqual({ kind: 'approve-for-session' });
            expect(toCopilotDecision({ type: 'permission', outcome: 'allow', scope: 'session' }, false)).toEqual({ kind: 'approve-once' });
            expect(toCopilotDecision({ type: 'permission', outcome: 'deny', scope: 'once', message: 'no' })).toEqual({ kind: 'reject', feedback: 'no' });
            expect(toCopilotDecision({ type: 'cancel' })).toMatchObject({ kind: 'reject' });
        });

        it('a shell ask goes through the policy, is announced as a call, and a denied one reads denied', async () => {
            const { session } = await open(
                async (ctx) => {
                    const d = await ctx.ask({ kind: 'shell', fullCommandText: 'rm -rf /', intention: 'wipe', commands: [], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true, toolCallId: 'sh1' });
                    expect(d).toMatchObject({ kind: 'reject', feedback: expect.any(String) });
                    ctx.emit('tool.execution_complete', { toolCallId: 'sh1', success: false, error: { message: 'Permission denied' } });
                    await ctx.say('Could not.');
                },
                { session: { policy: denyAll } }
            );
            const { events } = await drain(session.prompt('wipe'));
            const call = events.find((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call')!;
            expect(call).toMatchObject({ callId: 'sh1', name: 'shell', category: 'execute' });
            expect(updates(events, 'sh1')).toEqual(['pending', 'denied']);
            expect(events.find((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved')).toMatchObject({ outcome: 'deny', by: 'policy' });
        });

        it('a write ask carries its diff as coding.diff, and an ask outside a turn is user-not-available', async () => {
            const { session, fake } = await open(async (ctx) => {
                await ctx.ask({ kind: 'write', fileName: 'src/a.ts', diff: '--- a\n+++ b\n', intention: 'edit', canOfferSessionApproval: true, toolCallId: 'w1' });
                await ctx.builtin('w1', 'edit', { path: 'src/a.ts' }, { output: 'ok' });
                await ctx.say('Edited.');
            });
            const { events } = await drain(session.prompt('edit'));
            const t = createTranscript(session.id);
            const reduce = createReducer({ extensions: [codingExtension()] });
            for (const e of events) reduce(t, e);
            expect(codingState(t)!.diffs).toMatchObject([{ path: 'src/a.ts', unifiedDiff: '--- a\n+++ b\n', callId: 'w1' }]);
            expect(updates(events, 'w1')).toEqual(['pending', 'in_progress', 'completed']);
            const outside = await fake.sessions[0]!.config.onPermissionRequest!({ kind: 'read', path: 'x', intention: 'y' }, { sessionId: session.id });
            expect(outside).toEqual({ kind: 'user-not-available' });
        });

        it('the ask_user tool is an input request whose answer goes back as text', async () => {
            const { session } = await open(
                async (ctx) => {
                    const a = await ctx.askUser({ question: 'Deploy?', choices: ['yes', 'no'] });
                    expect(a).toEqual({ answer: 'yes', wasFreeform: false });
                    const b = await ctx.askUser({ question: 'Name?' });
                    expect(b).toEqual({ answer: 'Ada', wasFreeform: true });
                    await ctx.say('Thanks.');
                },
                { session: { interactive: true } }
            );
            let n = 0;
            const { events } = await drain(session.prompt('go'), async (e) => {
                if (e.type === 'request' && e.kind === 'input') await session.respond(e.requestId, { type: 'input', answers: n++ === 0 ? { choice: 'yes' } : 'Ada' });
            });
            const requests = events.filter((e): e is Extract<AgentEvent, { type: 'request' }> => e.type === 'request');
            expect(requests[0]).toMatchObject({ kind: 'input', toolName: 'ask_user', message: 'Deploy?', options: [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }] });
            expect(requests[1]).toMatchObject({ kind: 'input', message: 'Name?', schema: { type: 'string' } });
        });

        it('answerText reads a string, an array, an object’s first value, and nothing', () => {
            expect(answerText('a')).toBe('a');
            expect(answerText(['a', 'b'])).toBe('a, b');
            expect(answerText({ answer: 'yes' })).toBe('yes');
            expect(answerText({ answers: ['x'] })).toBe('x');
            expect(answerText(undefined)).toBe('');
            expect(answerText(3)).toBe('3');
        });
    });

    describe('built-in tools', () => {
        it('a shell execution streams its output as coding.terminal and exits', async () => {
            const { session } = await open(async (ctx) => {
                await ctx.builtin('b1', 'bash', { command: 'ls' }, { partial: ['a\n', 'b\n'], output: 'a\nb\n' });
                await ctx.say('Listed.');
            });
            const { events } = await drain(session.prompt('ls'));
            const t = createTranscript(session.id);
            const reduce = createReducer({ extensions: [codingExtension()] });
            for (const e of events) reduce(t, e);
            expect(codingState(t)!.terminals.b1).toEqual({ output: 'a\nb\n', truncated: false, exitCode: 0 });
            expect(events.find((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call')).toMatchObject({ name: 'bash', category: 'execute', input: { command: 'ls' } });
            expect(events.find((e) => e.type === 'tool-update' && e.status === 'completed')).toMatchObject({ output: 'a\nb\n' });
        });

        it('a failure with neither an error nor content still reads as a failure', async () => {
            const { session } = await open(async (ctx) => {
                ctx.emit('tool.execution_start', { toolCallId: 'e1', toolName: 'view', arguments: {} });
                ctx.emit('tool.execution_complete', { toolCallId: 'e1', success: false, result: { content: '' } });
                await ctx.say('Hm.');
            });
            const { events } = await drain(session.prompt('go'));
            expect(events.find((e) => e.type === 'tool-update' && e.status === 'failed')).toMatchObject({ error: 'The tool call failed.' });
        });

        it('an MCP tool is named server/tool; a failed one carries the error', async () => {
            const { session } = await open(async (ctx) => {
                ctx.emit('tool.execution_start', { toolCallId: 'm1', toolName: 'gh-issues', mcpServerName: 'gh', mcpToolName: 'issues', arguments: { q: 1 } });
                ctx.emit('tool.execution_progress', { toolCallId: 'm1', progressMessage: 'fetching' });
                ctx.emit('tool.execution_complete', { toolCallId: 'm1', success: false, error: { message: 'timeout' } });
                await ctx.say('Failed.');
            });
            const { events } = await drain(session.prompt('go'));
            expect(events.find((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call')).toMatchObject({ callId: 'm1', name: 'gh/issues', input: { q: 1 } });
            expect(updates(events, 'm1')).toEqual(['pending', 'in_progress', 'failed']);
            expect(events.find((e) => e.type === 'tool-update' && e.status === 'failed')).toMatchObject({ error: 'timeout' });
        });

        it('a structured result is the call’s output', async () => {
            const { session } = await open(async (ctx) => {
                ctx.emit('tool.execution_start', { toolCallId: 's1', toolName: 'view', arguments: { path: 'a' } });
                ctx.emit('tool.execution_complete', { toolCallId: 's1', success: true, result: { content: 'text', structuredContent: { lines: 3 } } });
                await ctx.say('Viewed.');
            });
            const { events } = await drain(session.prompt('go'));
            expect(events.find((e) => e.type === 'tool-update' && e.status === 'completed')).toMatchObject({ output: { lines: 3 } });
            expect(events.find((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call')).toMatchObject({ category: 'read' });
        });
    });

    describe('config', () => {
        it('advertises the runtime’s enabled models with the session’s own first when the list omits it, and the effort the model supports', async () => {
            const { all, session, settle } = await open(say('x'), { session: { model: 'custom-gateway', reasoningEffort: 'high' } });
            await session.close();
            await settle();
            const config = configOf(all)[0]!;
            expect(config.options.map((o) => o.id)).toEqual(['model', 'reasoningEffort']);
            const model = config.options[0]!;
            expect(model.current).toBe('custom-gateway');
            expect(model.values.map((v) => v.id)).toEqual(['custom-gateway', 'gpt-5', 'claude-sonnet-4.5']);
            expect(model.values[1]).toEqual({ id: 'gpt-5', label: 'GPT-5' });
            // An unlisted model: the runtime said nothing about its efforts, so all five are offered.
            expect(config.options[1]).toMatchObject({ current: 'high', values: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }] });
        });

        it('takes the model from session.start when none was asked for, and lists the model’s own efforts', async () => {
            const { all, session, settle } = await open(say('x'));
            await session.close();
            await settle();
            const config = configOf(all)[0]!;
            expect(config.options[0]).toMatchObject({ id: 'model', current: 'gpt-5' });
            expect(config.options[1]).toEqual({ id: 'reasoningEffort', label: 'Reasoning effort', values: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], current: 'medium' });
        });

        it('copilotCli({ models }) replaces the list; a model without reasoning support has no effort option', async () => {
            const { all, session, settle } = await open(say('x'), { agent: { models: [{ id: 'claude-sonnet-4.5', label: 'Sonnet' }] }, session: { model: 'claude-sonnet-4.5' } });
            await session.close();
            await settle();
            expect(configOf(all)[0]!.options).toEqual([{ id: 'model', label: 'Model', values: [{ id: 'claude-sonnet-4.5', label: 'Sonnet' }], current: 'claude-sonnet-4.5' }]);
        });

        it('configure({ model, reasoningEffort }) calls setModel and re-announces the whole list; the runtime’s own model_change does not duplicate it', async () => {
            const { all, session, fake, settle } = await open(say('x'));
            await session.configure!({ model: 'claude-sonnet-4.5' });
            expect(fake.sessions[0]!.setModels).toEqual([{ model: 'claude-sonnet-4.5', options: {} }]);
            await session.configure!({ model: 'gpt-5', reasoningEffort: 'low' });
            expect(fake.sessions[0]!.setModels[1]).toEqual({ model: 'gpt-5', options: { reasoningEffort: 'low' } });
            await expect(session.configure!({ reasoningEffort: 'ultra' })).rejects.toMatchObject({ code: 'protocol_error' });
            await session.configure!({ unrelated: 'x' });
            // A change the runtime makes on its own is announced too.
            fake.sessions[0]!.emit('session.model_change', { newModel: 'claude-sonnet-4.5' });
            await session.close();
            await settle();
            const configs = configOf(all);
            expect(configs.map((c) => c.options[0]!.current)).toEqual(['gpt-5', 'claude-sonnet-4.5', 'gpt-5', 'claude-sonnet-4.5']);
            // Sonnet reports no reasoning support, so its effort is not offered; gpt-5's is, at the effort just set.
            expect(configs[1]!.options.map((o) => o.id)).toEqual(['model']);
            expect(configs[2]!.options.map((o) => o.id)).toEqual(['model', 'reasoningEffort']);
            expect(configs[2]!.options[1]).toMatchObject({ current: 'low' });
        });

        it('configOptions offers nothing until a model is known', () => {
            expect(configOptions({}, toModelValues(MODELS))).toEqual([]);
            expect(toModelValues(MODELS).map((m) => m.id)).toEqual(['gpt-5', 'claude-sonnet-4.5']);
        });
    });

    describe('turn outcomes', () => {
        it('reports usage per model call under the shared keys, summed for the turn and the session', async () => {
            const { session } = await open(async (ctx) => {
                ctx.usage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1, cost: 27 });
                await ctx.say('one');
                ctx.usage({ inputTokens: 20, outputTokens: 5 });
            });
            const first = await drain(session.prompt('a'));
            const usage = first.events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
            expect(usage.map((u) => u.scope)).toEqual(['turn', 'session', 'turn', 'session']);
            expect(usage[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 2, reasoningTokens: 1 });
            expect(usage[2]!.usage).toMatchObject({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
            // `cost` is the premium-request multiplier, not money: it never becomes `costUsd`.
            expect(first.result).toMatchObject({ usage: { totalTokens: 40 } });
            expect(first.result.costUsd).toBeUndefined();
            expect(usage.every((u) => u.costUsd === undefined)).toBe(true);
            const second = await drain(session.prompt('b'));
            const session2 = second.events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage' && e.scope === 'session').at(-1)!;
            expect(session2.usage).toMatchObject({ totalTokens: 80 });
            expect(toUsage({ model: 'm', cacheWriteTokens: 4 })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheCreationInputTokens: 4 });
        });

        it('cancel() aborts the runtime and the turn ends cancelled', async () => {
            const { session, fake, finish } = await open(async (ctx) => {
                await ctx.say('starting');
                await ctx.abortRequested;
                await ctx.say('never shown');
            });
            const { events, result } = await drain(session.prompt('go'), async (e) => {
                if (e.type === 'part-end') await session.cancel();
            });
            expect(result).toMatchObject({ stopReason: 'cancelled' });
            expect(fake.sessions[0]!.aborts).toBe(1);
            expect(textOf(events)).toBe('starting');
            await finish();
        });

        it('a session.error is an error event and, followed by idle, an error turn with the mapped code', async () => {
            const { session } = await open((ctx) => ctx.error({ message: 'rate limit exceeded', statusCode: 429 }));
            const { events, result } = await drain(session.prompt('go'));
            expect(result).toMatchObject({ stopReason: 'error', error: { code: 'rate_limited' } });
            expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'rate_limited', recoverable: false });
        });

        it('a session.error the runtime never follows with idle still ends the turn', async () => {
            const { session } = await open(async (ctx) => {
                ctx.error({ message: 'unauthorized' });
                ctx.idle = () => {}; // the fake would go idle on return; this runtime does not
                await new Promise((r) => setTimeout(r, 100));
            });
            const { result } = await drain(session.prompt('go'));
            expect(result).toMatchObject({ stopReason: 'error', error: { code: 'auth_required' } });
        });

        it('toErrorCode reads status codes and messages', () => {
            expect(toErrorCode({ statusCode: 401 })).toBe('auth_required');
            expect(toErrorCode({ statusCode: 429 })).toBe('rate_limited');
            expect(toErrorCode({ message: 'context window exceeded' })).toBe('context_exceeded');
            expect(toErrorCode({ errorType: 'quota', message: 'x' })).toBe('rate_limited');
            expect(toErrorCode({ message: 'boom' })).toBe('provider_error');
        });

        it('a send() the runtime refuses fails the turn — as process_exited when the runtime is gone', async () => {
            const gone = await open(say('x'), { fake: { failSend: new Error('Connection is closed') } });
            const r1 = await drain(gone.session.prompt('go'));
            expect(r1.result).toMatchObject({ stopReason: 'error', error: { code: 'process_exited' } });
            const refused = await open(say('x'), { fake: { failSend: new Error('bad request') } });
            const r2 = await drain(refused.session.prompt('go'));
            expect(r2.result).toMatchObject({ stopReason: 'error', error: { code: 'provider_error' } });
        });

        it('a second prompt during a turn is refused as busy (no steering)', async () => {
            const { session } = await open(say('reply'));
            const a = session.prompt('one');
            await expect(drain(session.prompt('two'))).rejects.toThrow(/busy/);
            expect((await drain(a)).result).toMatchObject({ stopReason: 'end_turn' });
            expect((await drain(session.prompt('two'))).result).toMatchObject({ stopReason: 'end_turn' });
        });
    });

    describe('sub-agents', () => {
        it('a subagent is an agent-start bound to its spawning call; its events nest under it; completion settles both', async () => {
            const { session, finish } = await open(async (ctx) => {
                ctx.emit('tool.execution_start', { toolCallId: 'task1', toolName: 'task', arguments: { agent: 'reviewer' } });
                ctx.emit('subagent.started', { toolCallId: 'task1', agentName: 'reviewer', agentDisplayName: 'Reviewer', agentDescription: 'Reviews code.', model: 'gpt-5' });
                await ctx.builtin('sub_call', 'view', { path: 'a' }, { output: 'x', agentId: 'agent-7' });
                await ctx.say('Looks fine.', { agentId: 'agent-7' });
                ctx.emit('assistant.usage', { model: 'gpt-5', inputTokens: 4, outputTokens: 4 }, { agentId: 'agent-7' });
                ctx.emit('subagent.completed', { toolCallId: 'task1', agentName: 'reviewer', agentDisplayName: 'Reviewer', totalTokens: 8 });
                ctx.emit('tool.execution_complete', { toolCallId: 'task1', success: true, result: { content: 'Looks fine.' } });
                await ctx.say('Done.');
            });
            const { events, result } = await drain(session.prompt('review'));
            expect(result).toMatchObject({ stopReason: 'end_turn' });
            const start = events.find((e): e is Extract<AgentEvent, { type: 'agent-start' }> => e.type === 'agent-start')!;
            expect(start).toMatchObject({ agentId: 'task1', callId: 'task1', kind: 'subagent', title: 'Reviewer', description: 'Reviews code.', model: 'gpt-5' });
            const nested = events.filter((e) => e.parentCallId === 'task1');
            expect(nested.map((e) => e.type)).toEqual(['agent-start', 'agent-update', 'tool-call', 'tool-update', 'tool-update', 'tool-update', 'part-start', 'part-delta', 'part-delta', 'part-end', 'agent-update', 'agent-update']);
            expect(events.find((e) => e.type === 'part-start' && e.parentCallId === 'task1')).toMatchObject({ actor: 'Reviewer' });
            const agentUpdates = events.filter((e): e is Extract<AgentEvent, { type: 'agent-update' }> => e.type === 'agent-update');
            expect(agentUpdates.map((u) => u.status)).toEqual(['running', 'running', 'completed']);
            expect(agentUpdates[1]!.usage).toMatchObject({ totalTokens: 8 });
            expect(agentUpdates[2]!.usage).toEqual({ totalTokens: 8 });
            // The host's usage did not absorb the sub-agent's.
            expect(events.some((e) => e.type === 'usage')).toBe(false);
            expect(updates(events, 'task1')).toEqual(['pending', 'in_progress', 'completed']);
            await finish();
        });

        it('a failed subagent fails its call; cancel({ agentId }) is refused', async () => {
            const { session } = await open(async (ctx) => {
                ctx.emit('subagent.started', { toolCallId: 't2', agentName: 'x', agentDisplayName: '', agentDescription: 'd' });
                await expect(session.cancel({ agentId: 't2' })).rejects.toMatchObject({ code: 'protocol_error' });
                ctx.emit('subagent.failed', { toolCallId: 't2', agentName: 'x', agentDisplayName: '', error: 'crashed' });
                await ctx.say('Sorry.');
            });
            const { events } = await drain(session.prompt('go'));
            expect(events.find((e): e is Extract<AgentEvent, { type: 'agent-start' }> => e.type === 'agent-start')).toMatchObject({ title: 'x' });
            expect(events.find((e) => e.type === 'agent-update' && e.status === 'failed')).toMatchObject({ error: { message: 'crashed' } });
            expect(updates(events, 't2')).toEqual(['pending', 'in_progress', 'failed']);
            await expect(session.cancel({ agentId: 'nope' })).rejects.toMatchObject({ code: 'protocol_error' });
        });

        it('a running sub-agent is cancelled with the turn and when the session closes', async () => {
            const { session, all, settle } = await open(async (ctx) => {
                ctx.emit('subagent.started', { toolCallId: 't3', agentName: 'x', agentDisplayName: 'X', agentDescription: 'd' });
                await ctx.abortRequested;
            });
            const { events } = await drain(session.prompt('go'), async (e) => {
                if (e.type === 'agent-update') await session.cancel();
            });
            expect(events.filter((e) => e.type === 'agent-update').map((e) => (e as { status: string }).status)).toEqual(['running', 'cancelled']);
            const { session: s2, all: all2, settle: settle2 } = await open(async (ctx) => {
                ctx.emit('subagent.started', { toolCallId: 't4', agentName: 'y', agentDisplayName: 'Y', agentDescription: 'd' });
                await ctx.say('bye');
            });
            await drain(s2.prompt('go'));
            await s2.close();
            await settle2();
            expect(all2.filter((e) => e.type === 'agent-update').map((e) => (e as { status: string }).status)).toEqual(['running', 'cancelled']);
            await session.close();
            await settle();
            void all;
        });
    });

    describe('session-level events', () => {
        it('passes unknown events through as ext, inside and outside a turn, and drops turn-bound noise and runtime chatter', async () => {
            const { session, all, fake, settle } = await open(async (ctx) => {
                ctx.emit('session.usage_info', { currentTokens: 10, tokenLimit: 100, messagesLength: 1 });
                ctx.emit('assistant.streaming_delta', { totalResponseSizeBytes: 3 } as never);
                ctx.emit('model.call_start' as never, { turnId: '0' } as never);
                ctx.emit('session.info', { message: 'hi', infoType: 'x' } as never);
                await ctx.say('ok');
            });
            const { events } = await drain(session.prompt('go'));
            const ext = events.filter((e): e is Extract<AgentEvent, { type: 'ext' }> => e.type === 'ext');
            expect(ext.map((e) => [e.ns, e.name])).toEqual([[COPILOT_CLI_NS, 'session.usage_info'], [COPILOT_CLI_NS, 'session.info']]);
            fake.sessions[0]!.emit('session.compaction_start', { trigger: 'x' } as never);
            fake.sessions[0]!.emit('assistant.message_delta', { messageId: 'stray', deltaContent: 'x' });
            fake.sessions[0]!.emit('session.background_tasks_changed', {} as never);
            await session.close();
            await settle();
            const outside = all.filter((e) => e.type === 'ext' && e.turnId === undefined);
            expect(outside.map((e) => (e as { name: string }).name)).toEqual(['session.compaction_start']);
        });
    });

    describe('lifecycle', () => {
        it('starts the client lazily, once, and stops an owned client on dispose', async () => {
            const fake = fakeClient(say('x'));
            const agent = copilotCli({ client: fake.client });
            expect(fake.starts).toBe(0);
            const a = await agent.session({ cwd: '/repo' });
            const b = await agent.session({ cwd: '/repo' });
            expect(fake.starts).toBe(1);
            await agent.dispose();
            expect(fake.sessions.map((s) => s.disconnects)).toEqual([1, 1]);
            // The client was handed in: stopping it is the caller's business.
            expect(fake.stops).toBe(0);
            await expect(agent.session({ cwd: '/repo' })).rejects.toMatchObject({ code: 'protocol_error' });
            void a;
            void b;
        });

        it('a runtime that does not start is process_exited; a refused session is provider_error', async () => {
            const down = copilotCli({ client: fakeClient(say('x'), { failStart: new Error('spawn ENOENT') }).client });
            await expect(down.session({ cwd: '/repo' })).rejects.toMatchObject({ code: 'process_exited' });
            const refusing = copilotCli({ client: fakeClient(say('x'), { failCreate: new Error('bad model') }).client });
            await expect(refusing.session({ cwd: '/repo' })).rejects.toMatchObject({ code: 'provider_error', message: expect.stringContaining('bad model') });
        });

        it('a runtime that is not signed in is auth_required, unless the session brings its own provider', async () => {
            const fake = fakeClient(say('x'), { auth: { isAuthenticated: false } });
            const agent = copilotCli({ client: fake.client });
            await expect(agent.session({ cwd: '/repo' })).rejects.toMatchObject({ code: 'auth_required', data: { hint: 'copilot login' } });
            const byok = await agent.session({ cwd: '/repo', provider: { baseUrl: 'http://localhost:11434/v1' }, model: 'local' });
            expect(fake.sessions[0]!.config).toMatchObject({ provider: { baseUrl: 'http://localhost:11434/v1' }, model: 'local' });
            await byok.close();
        });

        it('resumes a session by ref with the epoch advanced, and lists sessions', async () => {
            const fake = fakeClient(say('again'));
            const agent = copilotCli({ client: fake.client });
            const first = await agent.session({ cwd: '/repo' });
            await drain(first.prompt('one'));
            const ref: SessionRef = first.ref;
            await first.close();
            const resumed = await agent.session({ cwd: '/repo', resume: ref });
            expect(fake.sessions[1]).toMatchObject({ sessionId: ref.id, resumed: true });
            expect(resumed.ref).toEqual({ agent: 'copilot-cli', v: 1, id: ref.id, data: { cwd: '/repo', epoch: 2 } });
            const { events } = await drain(resumed.prompt('two'));
            expect(events[0]!.epoch).toBe(2);
            expect(textOf(events)).toBe('again');
            const list = await agent.listSessions();
            expect(list.map((s) => s.ref.id)).toEqual([ref.id, ref.id]);
            expect(list[0]).toMatchObject({ title: `Session ${ref.id}`, updatedAt: 1000, ref: { data: { cwd: '/repo' } } });
        });

        it('passes the session options through: system prompt, tools filter, agents, effort, directories', async () => {
            const fake = fakeClient(say('x'));
            const agent = copilotCli({ client: fake.client });
            await agent.session({ cwd: '/repo', additionalDirectories: ['/lib'], system: 'Be brief.', availableTools: ['view'], excludedTools: ['bash'], reasoningEffort: 'low', agents: { reviewer: { description: 'Reviews.', prompt: 'Review.', tools: ['view'], model: 'gpt-5' }, plain: { description: 'Plain.' } }, streaming: false });
            expect(fake.sessions[0]!.config).toMatchObject({
                workingDirectory: '/repo',
                additionalDirectories: ['/lib'],
                systemMessage: { mode: 'append', content: 'Be brief.' },
                availableTools: ['view'],
                excludedTools: ['bash'],
                reasoningEffort: 'low',
                customAgents: [
                    { name: 'reviewer', description: 'Reviews.', prompt: 'Review.', tools: ['view'], model: 'gpt-5' },
                    { name: 'plain', description: 'Plain.', prompt: 'Plain.' }
                ],
                streaming: false
            });
            expect(fake.sessions[0]!.config.tools).toBeUndefined();
        });

        it('prompting a closed session is refused, and a late join replays from the start', async () => {
            const { session, all, settle } = await open(say('x'));
            const { events } = await drain(session.prompt('go'));
            await session.close();
            await settle();
            expect(all.slice(0, events.length + 1).map((e) => e.seq)).toEqual(all.slice(0, events.length + 1).map((_, i) => i + 1));
            await expect(session.prompt('again').result).rejects.toMatchObject({ code: 'protocol_error' });
        });

        it('a gitHubToken turns the stored login off unless useLoggedInUser says otherwise', () => {
            expect(toClientOptions({})).toEqual({ clientInfo: { integrationName: '@sigx/ai-agent-copilot-cli', applicationVersion: '0.1.0' } });
            expect(toClientOptions({ gitHubToken: 'ghp_x' })).toMatchObject({ gitHubToken: 'ghp_x', useLoggedInUser: false });
            expect(toClientOptions({ gitHubToken: 'ghp_x', useLoggedInUser: true })).toMatchObject({ useLoggedInUser: true });
            expect(toClientOptions({ env: { A: '1' }, cwd: '/w', baseDirectory: '/home', logLevel: 'error' })).toMatchObject({ env: { A: '1' }, workingDirectory: '/w', baseDirectory: '/home', logLevel: 'error' });
            expect(toClientOptions({ useLoggedInUser: false })).toMatchObject({ useLoggedInUser: false });
        });

        it('requires the SDK when no client is given', async () => {
            const agent = copilotCli({ cliPath: '/nonexistent/copilot', env: {} });
            // The bundled runtime is present in this checkout, so the failure is the missing executable, reported as process_exited.
            await expect(agent.session({ cwd: tmpdir() })).rejects.toMatchObject({ code: expect.stringMatching(/process_exited|protocol_error/) });
            await agent.dispose();
        }, 30_000);
    });
});

describe('@sigx/ai-agent-copilot-cli (live)', () => {
    const liveReason = process.env.SIGX_LIVE_COPILOT ? undefined : 'SIGX_LIVE_COPILOT is not set';
    it.skipIf(!!liveReason)(
        'answers a short prompt, lists models, and runs a client tool',
        async () => {
            const agent = copilotCli();
            const session: AgentSession = await agent.session({ cwd: tmpdir(), interactive: false, policy: allowAll, tools: [echo] });
            const all: AgentEvent[] = [];
            const reading = (async () => {
                for await (const e of session.subscribe({ epoch: 0, seq: 0 })) all.push(e);
            })();
            try {
                const { events, result } = await drain(session.prompt('Call the echo tool with {"n": 1}, then reply with exactly the word: pong'));
                expect(result.stopReason).toBe('end_turn');
                expect(textOf(events).toLowerCase()).toContain('pong');
                expect(events.some((e) => e.type === 'tool-call' && e.name === 'echo')).toBe(true);
                expect(events.some((e) => e.type === 'usage')).toBe(true);
            } finally {
                await session.close();
                await reading;
                await agent.dispose();
            }
            const config = configOf(all)[0]!;
            expect(config.options.find((o) => o.id === 'model')!.values.length).toBeGreaterThan(1);
        },
        180_000
    );
    if (liveReason) console.log(`[ai-agent-copilot-cli] live smoke skipped: ${liveReason}`);
});
