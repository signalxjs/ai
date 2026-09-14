// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { allowAll, denyAll, createTranscript, createReducer, agentMessages, spawnedAgent, type AgentEvent, type Decision, type SessionRef } from '@sigx/ai-agent';
import { codingExtension, codingState } from '@sigx/ai-agent/coding';
import { checkEventInvariants } from '@sigx/ai-agent/testing';
import { resolveExecutable } from '@sigx/ai-agent-node';
import { codex, CODEX_CAPABILITIES, toErrorCode } from '@sigx/ai-agent-codex';
import { fakeAppServer, say, type TurnProgram } from './fake-app-server';
import { updateSubAgent, type SubAgents } from '../src/stream';
import type { UnstampedEvent } from '@sigx/ai-agent';

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

    it('configure({ sandbox }) is sent as sandboxPolicy on the next turn/start', async () => {
        const fake = fakeAppServer({ onTurn: say('x') });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        await session.prompt('go').result;
        expect(fake.requests.at(-1)!.params).not.toHaveProperty('sandboxPolicy');
        const expected = {
            'read-only': { type: 'readOnly', networkAccess: false },
            'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
            'danger-full-access': { type: 'dangerFullAccess' }
        };
        for (const [mode, policy] of Object.entries(expected)) {
            await session.configure!({ sandbox: mode });
            await session.prompt('go').result;
            expect(fake.requests.at(-1)!.params).toMatchObject({ threadId: session.id, sandboxPolicy: policy });
        }
    });

    it('a granular approval policy and an unmodelled sandbox are still listed among their config values', async () => {
        const fake = fakeAppServer({
            onTurn: say('x'),
            thread: {
                approvalPolicy: { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } },
                sandbox: { type: 'externalSandbox', networkAccess: 'restricted' }
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        let config: Extract<AgentEvent, { type: 'config' }> | undefined;
        for await (const e of session.subscribe({ epoch: 0, seq: 0 })) {
            if (e.type === 'config') {
                config = e;
                break;
            }
        }
        for (const o of config!.options) expect(o.values.map((v) => v.id), o.id).toContain(o.current);
        expect(config!.options.find((o) => o.id === 'approvalPolicy')).toMatchObject({ current: 'granular', values: expect.arrayContaining([{ id: 'granular', label: 'Granular (managed by Codex)' }]) });
        expect(config!.options.find((o) => o.id === 'sandbox')).toMatchObject({ current: 'unknown', values: expect.arrayContaining([{ id: 'unknown', label: 'Unknown' }]) });
    });

    it('plan items stream as text parts, not as ext events', async () => {
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.item({ type: 'plan', id: 'plan_1', text: '' }, 'started');
                await ctx.notify('item/plan/delta', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'plan_1', delta: 'Step one' });
                await ctx.item({ type: 'plan', id: 'plan_1', text: 'Step one, then two' }, 'completed');
                await say('ok')(ctx);
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const { events } = await drain(session.prompt('plan it'));
        expect(events.find((e) => e.type === 'ext' && e.name === 'item.plan')).toBeUndefined();
        const plan = events.filter((e) => 'partId' in e && e.partId === 'plan_1');
        expect(plan.map((e) => e.type)).toEqual(['part-start', 'part-delta', 'part-delta', 'part-end']);
        expect(plan[0]).toMatchObject({ kind: 'text' });
        expect(plan.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta').map((e) => e.delta)).toEqual(['Step one', ', then two']);
        expect(textOf(events)).toBe('Step one, then twook');
    });

    describe('sub-agents (#99)', () => {
        const collab = (id: string, tool: string, status: string, extra: Record<string, unknown>) => ({ type: 'collabAgentToolCall', id, tool, status, senderThreadId: 'thread_1', receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {}, ...extra });
        const agentEvents = (events: AgentEvent[], agentId?: string) => events.filter((e): e is Extract<AgentEvent, { type: 'agent-start' | 'agent-update' }> => (e.type === 'agent-start' || e.type === 'agent-update') && (agentId === undefined || e.agentId === agentId));
        /** Every session event from now until `close()`, for the invariants (a turn's own iterator skips session-level events). */
        const observe = (session: { subscribe(): AsyncIterable<AgentEvent> }) => {
            const events: AgentEvent[] = [];
            const done = (async () => {
                for await (const e of session.subscribe()) events.push(e);
            })();
            return { events, done };
        };

        it('declares subagents: control', () => {
            expect(CODEX_CAPABILITIES.subagents).toBe('control');
        });

        it('updateSubAgent emits a change of output or error even when status and summary repeat; a true repeat stays quiet', () => {
            const agents: SubAgents = new Map([['a', { status: 'running' }]]);
            const emitted: UnstampedEvent[] = [];
            const emit = (e: UnstampedEvent) => emitted.push(e);
            updateSubAgent(agents, emit, 'a', { status: 'running', output: 'partial' });
            updateSubAgent(agents, emit, 'a', { status: 'running', error: 'hiccup' });
            updateSubAgent(agents, emit, 'a', { status: 'running' });
            expect(emitted.map((e) => (e.type === 'agent-update' ? [e.status, e.output, e.error?.message] : []))).toEqual([
                ['running', 'partial', undefined],
                ['running', undefined, 'hiccup']
            ]);
        });

        it('spawnAgent binds the child thread to the collab call; a later wait settles it once with its output', async () => {
            const fake = fakeAppServer({
                onTurn: async (ctx) => {
                    await ctx.item(collab('collab_1', 'spawnAgent', 'inProgress', { prompt: 'Find the tests', model: 'gpt-5-mini' }), 'started');
                    await ctx.item(collab('collab_1', 'spawnAgent', 'completed', { prompt: 'Find the tests', model: 'gpt-5-mini', receiverThreadIds: ['child_1'], agentsStates: { child_1: { status: 'pendingInit', message: null } } }), 'completed');
                    await ctx.item(collab('collab_2', 'wait', 'inProgress', { receiverThreadIds: ['child_1'], agentsStates: { child_1: { status: 'running', message: null } } }), 'started');
                    await ctx.item(collab('collab_2', 'wait', 'completed', { receiverThreadIds: ['child_1'], agentsStates: { child_1: { status: 'completed', message: 'Found 3 test files' } } }), 'completed');
                    // A second report of the same terminal state is not a second terminal update.
                    await ctx.item(collab('collab_3', 'listAgents', 'completed', { agentsStates: { child_1: { status: 'completed', message: 'Found 3 test files' } } }), 'completed');
                    await say('Done.')(ctx);
                }
            });
            const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
            const all = observe(session);
            const { events, result } = await drain(session.prompt('delegate'));
            expect(result).toMatchObject({ stopReason: 'end_turn' });
            expect(events.find((e) => e.type === 'ext' && e.name.startsWith('item.collab'))).toBeUndefined();
            expect(events.filter((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call').map((e) => [e.callId, e.name])).toEqual([
                ['collab_1', 'collab/spawnAgent'],
                ['collab_2', 'collab/wait'],
                ['collab_3', 'collab/listAgents']
            ]);
            expect(events.find((e) => e.type === 'tool-call' && e.callId === 'collab_1')).toMatchObject({ category: 'other', input: { prompt: 'Find the tests', model: 'gpt-5-mini', receiverThreadIds: [] } });
            expect(updates(events, 'collab_1')).toEqual(['pending', 'in_progress', 'completed']);
            const agent = agentEvents(events, 'child_1');
            expect(agent.map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running', 'completed']);
            expect(agent[0]).toMatchObject({ type: 'agent-start', agentId: 'child_1', callId: 'collab_1', kind: 'subagent', description: 'Find the tests', model: 'gpt-5-mini', parentCallId: 'collab_1' });
            expect(agent[2]).toMatchObject({ type: 'agent-update', status: 'completed', output: 'Found 3 test files', parentCallId: 'collab_1' });
            // The spawn call is announced before the agent that binds to it.
            expect(events.findIndex((e) => e.type === 'tool-call' && e.callId === 'collab_1')).toBeLessThan(events.indexOf(agent[0]!));
            await session.close();
            await all.done;
            checkEventInvariants(all.events);
        });

        it('interruptAgent and closeAgent cancel a child once; errored and notFound fail it', async () => {
            const fake = fakeAppServer({
                onTurn: async (ctx) => {
                    await ctx.item(collab('c1', 'spawnAgent', 'completed', { prompt: 'a', receiverThreadIds: ['a1'], agentsStates: { a1: { status: 'running', message: null } } }), 'completed');
                    await ctx.item(collab('c1b', 'spawnAgent', 'completed', { prompt: 'b', receiverThreadIds: ['a2'], agentsStates: { a2: { status: 'running', message: null } } }), 'completed');
                    await ctx.item(collab('c2', 'interruptAgent', 'completed', { receiverThreadIds: ['a1'], agentsStates: { a1: { status: 'interrupted', message: null } } }), 'completed');
                    await ctx.item(collab('c3', 'closeAgent', 'completed', { receiverThreadIds: ['a1'], agentsStates: { a1: { status: 'shutdown', message: null } } }), 'completed');
                    await ctx.item(collab('c4', 'wait', 'failed', { receiverThreadIds: ['a2'], agentsStates: { a2: { status: 'errored', message: 'the model refused' } } }), 'completed');
                    await ctx.item(collab('c5', 'sendInput', 'completed', { receiverThreadIds: ['a3'], agentsStates: { a3: { status: 'notFound', message: null } } }), 'completed');
                    await say('ok')(ctx);
                }
            });
            const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
            const all = observe(session);
            const { events } = await drain(session.prompt('go'));
            expect(agentEvents(events, 'a1').map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running', 'cancelled']);
            expect(agentEvents(events, 'a2').map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running', 'failed']);
            expect(agentEvents(events, 'a2')[0]).toMatchObject({ callId: 'c1b', description: 'b' });
            expect(agentEvents(events, 'a2').at(-1)).toMatchObject({ error: { code: 'provider_error', message: 'the model refused' } });
            // A thread first reported by a non-spawn call is still an agent, without a spawning call.
            expect(agentEvents(events, 'a3').map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running', 'failed']);
            expect(agentEvents(events, 'a3')[0]).not.toHaveProperty('callId');
            expect(updates(events, 'c4')).toEqual(['pending', 'failed']);
            await session.close();
            await all.done;
            checkEventInvariants(all.events);
        });

        it('a subAgentActivity "started" for an unseen thread is the spawn call; other kinds for an unseen thread are call-less; kinds map onto statuses', async () => {
            const fake = fakeAppServer({
                onTurn: async (ctx) => {
                    await ctx.item({ type: 'subAgentActivity', id: 'sa1', kind: 'started', agentThreadId: 'child_9', agentPath: 'explorer' }, 'started');
                    await ctx.item({ type: 'subAgentActivity', id: 'sa1', kind: 'started', agentThreadId: 'child_9', agentPath: 'explorer' }, 'completed');
                    await ctx.item({ type: 'subAgentActivity', id: 'sa2', kind: 'interacted', agentThreadId: 'child_9', agentPath: 'explorer' }, 'completed');
                    await ctx.item({ type: 'subAgentActivity', id: 'sa3', kind: 'completed', agentThreadId: 'child_9', agentPath: 'explorer' }, 'completed');
                    // A thread first seen interacting (a spawn before our resume) has no spawning call.
                    await ctx.item({ type: 'subAgentActivity', id: 'sa4', kind: 'interacted', agentThreadId: 'child_10', agentPath: 'other' }, 'completed');
                    await ctx.item({ type: 'subAgentActivity', id: 'sa5', kind: 'completed', agentThreadId: 'child_10', agentPath: 'other' }, 'completed');
                    await say('ok')(ctx);
                }
            });
            const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
            const all = observe(session);
            const { events } = await drain(session.prompt('go'));
            const agent = agentEvents(events, 'child_9');
            expect(events.find((e) => e.type === 'tool-call' && e.callId === 'sa1')).toMatchObject({ name: 'collab/spawnAgent', category: 'other', input: { agentPath: 'explorer' } });
            expect(updates(events, 'sa1')).toEqual(['pending', 'completed']);
            expect(agent[0]).toMatchObject({ type: 'agent-start', agentId: 'child_9', callId: 'sa1', kind: 'subagent', title: 'explorer', parentCallId: 'sa1' });
            expect(agent.slice(1).map((e) => (e.type === 'agent-update' ? [e.status, e.summary] : []))).toEqual([
                ['running', 'started'],
                ['running', 'interacted'],
                ['completed', undefined]
            ]);
            const other = agentEvents(events, 'child_10');
            expect(other[0]).toMatchObject({ type: 'agent-start', agentId: 'child_10', title: 'other' });
            expect(other[0]).not.toHaveProperty('callId');
            expect(events.find((e) => e.type === 'tool-call' && e.callId === 'sa4')).toBeUndefined();
            expect(events.find((e) => e.type === 'ext' && e.name === 'item.subAgentActivity')).toBeUndefined();
            await session.close();
            await all.done;
            checkEventInvariants(all.events);
        });

        describe('child threads (#100)', () => {
            const activity = (id: string, kind: string, agentThreadId: string, agentPath = '/root/pong') => ({ type: 'subAgentActivity', id, kind, agentThreadId, agentPath });
            const message = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: 'final_answer' });
            const nestedText = (events: AgentEvent[], callId: string) =>
                events
                    .filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta' && e.parentCallId === callId)
                    .map((e) => e.delta)
                    .join('');

            it('the child thread streams nested under the spawn call (Codex 0.154 shape); its usage lands on the agent, not the host', async () => {
                const usage = { totalTokens: 9, inputTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 };
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        // Codex reports the child idle before the parent names it.
                        await ctx.notify('thread/status/changed', { threadId: 'child_1', status: { type: 'idle' } });
                        await ctx.item(activity('call_spawn', 'started', 'child_1'), 'started');
                        await ctx.item(activity('call_spawn', 'started', 'child_1'), 'completed');
                        const child = await ctx.child('child_1').startTurn('cturn_1');
                        await child.item(message('cmsg_1', ''), 'started');
                        await child.delta('cmsg_1', 'pong');
                        await child.item(message('cmsg_1', 'pong'), 'completed');
                        await child.usage(usage);
                        await child.complete();
                        await ctx.item(activity('subagent-completed-cturn_1', 'completed', 'child_1'), 'started');
                        await ctx.item(activity('subagent-completed-cturn_1', 'completed', 'child_1'), 'completed');
                        await say('pong')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                const { events, result } = await drain(session.prompt('delegate'));
                expect(result).toMatchObject({ stopReason: 'end_turn' });
                expect(nestedText(events, 'call_spawn')).toBe('pong');
                expect(events.find((e) => e.type === 'part-start' && e.parentCallId === 'call_spawn')).toMatchObject({ kind: 'text', actor: 'pong' });
                const agent = agentEvents(events, 'child_1');
                expect(agent[0]).toMatchObject({ type: 'agent-start', callId: 'call_spawn', title: '/root/pong' });
                const terminal = agent.filter((e) => e.type === 'agent-update' && e.status !== 'running');
                expect(terminal.map((e) => (e.type === 'agent-update' ? e.status : ''))).toEqual(['completed']);
                expect(agent.find((e) => e.type === 'agent-update' && e.usage !== undefined)).toMatchObject({ status: 'running', usage: { totalTokens: 9, inputTokens: 7, outputTokens: 2 }, parentCallId: 'call_spawn' });
                // The child's own tokens never reach the host totals, and its thread noise never becomes ext events.
                expect(events.filter((e) => e.type === 'usage')).toEqual([]);
                expect(events.find((e) => e.type === 'ext' && e.name === 'thread/status/changed')).toBeUndefined();
                const t = createTranscript(session.id);
                const reduce = createReducer();
                for (const e of events) reduce(t, e);
                expect(spawnedAgent(t, 'call_spawn')?.agentId).toBe('child_1');
                expect(agentMessages(t, 'child_1').map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))).toEqual(['pong']);
                expect(t.usage).toBeUndefined();
                // A finished or unknown agent cannot be cancelled.
                await expect(session.cancel({ agentId: 'child_1' })).rejects.toMatchObject({ name: 'AgentError', code: 'protocol_error' });
                await expect(session.cancel({ agentId: 'nobody' })).rejects.toMatchObject({ name: 'AgentError', code: 'protocol_error' });
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });

            it('child frames that arrive before the activity naming the child are held and replayed once it is known', async () => {
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        const child = await ctx.child('child_2').startTurn('cturn_2');
                        await child.item(message('cmsg_2', ''), 'started');
                        await ctx.item(activity('call_s2', 'started', 'child_2', '/root/early'), 'started');
                        await ctx.item(activity('call_s2', 'started', 'child_2', '/root/early'), 'completed');
                        await child.delta('cmsg_2', 'early');
                        await child.item(message('cmsg_2', 'early'), 'completed');
                        await child.complete();
                        await ctx.item(activity('done_2', 'completed', 'child_2', '/root/early'), 'completed');
                        await say('ok')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                const { events } = await drain(session.prompt('go'));
                expect(nestedText(events, 'call_s2')).toBe('early');
                expect(events.findIndex((e) => e.type === 'tool-call' && e.callId === 'call_s2')).toBeLessThan(events.findIndex((e) => e.type === 'part-start' && e.parentCallId === 'call_s2'));
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });

            it('cancel({ agentId }) interrupts the running child turn; the interrupted completion ends the agent cancelled once and the host turn goes on', async () => {
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        await ctx.item(activity('call_s3', 'started', 'child_3', '/root/slow'), 'started');
                        await ctx.item(activity('call_s3', 'started', 'child_3', '/root/slow'), 'completed');
                        const child = await ctx.child('child_3').startTurn('cturn_3');
                        await child.item(message('cmsg_3', ''), 'started');
                        await child.interrupted;
                        await child.complete('interrupted');
                        // Codex may drive the child again; that is not a second terminal.
                        await ctx.item(activity('done_3', 'completed', 'child_3', '/root/slow'), 'completed');
                        await say('stopped')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                const { events, result } = await drain(session.prompt('go'), async (e) => {
                    if (e.type === 'part-start' && e.parentCallId === 'call_s3') await session.cancel({ agentId: 'child_3' });
                });
                expect(result).toMatchObject({ stopReason: 'end_turn' });
                expect(fake.requests.filter((r) => r.method === 'turn/interrupt').map((r) => r.params)).toEqual([{ threadId: 'child_3', turnId: 'cturn_3' }]);
                const terminal = agentEvents(events, 'child_3').filter((e) => e.type === 'agent-update' && e.status !== 'running');
                expect(terminal.map((e) => (e.type === 'agent-update' ? e.status : ''))).toEqual(['cancelled']);
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });

            it('a cancel requested before the child turn starts is sent the moment it does', async () => {
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        await ctx.item(activity('call_s4', 'started', 'child_4', '/root/late'), 'started');
                        await ctx.item(activity('call_s4', 'started', 'child_4', '/root/late'), 'completed');
                        await new Promise((r) => setTimeout(r, 20));
                        const child = await ctx.child('child_4').startTurn('cturn_4');
                        await child.interrupted;
                        await child.complete('interrupted');
                        await say('stopped')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                let cancelled = false;
                const { events, result } = await drain(session.prompt('go'), async (e) => {
                    if (!cancelled && e.type === 'agent-update' && e.status === 'running') {
                        cancelled = true;
                        await session.cancel({ agentId: 'child_4' });
                    }
                });
                expect(result).toMatchObject({ stopReason: 'end_turn' });
                expect(fake.requests.filter((r) => r.method === 'turn/interrupt').map((r) => r.params)).toEqual([{ threadId: 'child_4', turnId: 'cturn_4' }]);
                expect(agentEvents(events, 'child_4').map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running', 'cancelled']);
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });

            it('a request raised on the child thread goes through the host policy, nested under the spawn call', async () => {
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        await ctx.item(activity('call_s5', 'started', 'child_5', '/root/shell'), 'started');
                        await ctx.item(activity('call_s5', 'started', 'child_5', '/root/shell'), 'completed');
                        const child = await ctx.child('child_5').startTurn('cturn_5');
                        const cmd = { type: 'commandExecution', id: 'ccmd', command: 'ls', cwd: '/repo', status: 'inProgress', aggregatedOutput: null, exitCode: null };
                        await child.item(cmd, 'started');
                        const r = await child.request<{ decision: string }>('item/commandExecution/requestApproval', { itemId: 'ccmd', command: 'ls', cwd: '/repo', availableDecisions: ['accept', 'decline'] });
                        await ctx.notify('turn/completed_decision', { threadId: ctx.threadId, turnId: ctx.turnId, decision: r.decision });
                        await child.item({ ...cmd, status: 'completed', aggregatedOutput: 'a b', exitCode: 0 }, 'completed');
                        await child.complete();
                        await ctx.item(activity('done_5', 'completed', 'child_5', '/root/shell'), 'completed');
                        await say('ok')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                const { events } = await drain(session.prompt('go'), async (e) => {
                    if (e.type === 'request') {
                        expect(e).toMatchObject({ kind: 'permission', parentCallId: 'call_s5' });
                        await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
                    }
                });
                expect(events.find((e) => e.type === 'ext' && e.name === 'turn/completed_decision')).toMatchObject({ data: { decision: 'accept' } });
                expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ by: 'client', outcome: 'allow', parentCallId: 'call_s5' });
                expect(events.find((e) => e.type === 'tool-call' && e.callId === 'ccmd')).toMatchObject({ parentCallId: 'call_s5' });
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });

            it('an older server announcing the child with thread/started + parentThreadId routes it under the collab spawn, speaking as its nickname', async () => {
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        await ctx.item(collab('collab_s6', 'spawnAgent', 'completed', { prompt: 'look', receiverThreadIds: ['child_6'], agentsStates: { child_6: { status: 'running', message: null } } }), 'completed');
                        await ctx.notify('thread/started', { thread: { id: 'child_6', preview: '', model: 'gpt-5', reasoningEffort: null, parentThreadId: ctx.threadId, agentNickname: 'Scout', agentRole: 'explorer' } });
                        const child = await ctx.child('child_6').startTurn('cturn_6');
                        await child.item(message('cmsg_6', ''), 'started');
                        await child.delta('cmsg_6', 'found it');
                        await child.item(message('cmsg_6', 'found it'), 'completed');
                        await child.complete();
                        await ctx.item(collab('collab_w6', 'wait', 'completed', { receiverThreadIds: ['child_6'], agentsStates: { child_6: { status: 'completed', message: 'found it' } } }), 'completed');
                        await say('ok')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                const { events } = await drain(session.prompt('go'));
                expect(nestedText(events, 'collab_s6')).toBe('found it');
                expect(events.find((e) => e.type === 'part-start' && e.parentCallId === 'collab_s6')).toMatchObject({ actor: 'Scout' });
                expect(events.find((e) => e.type === 'ext' && e.name === 'thread/started')).toBeUndefined();
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });

            it('a child turn named only by a top-level turnId is still the turn cancel({ agentId }) interrupts', async () => {
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        await ctx.item(activity('call_s8', 'started', 'child_8', '/root/lean'), 'started');
                        await ctx.item(activity('call_s8', 'started', 'child_8', '/root/lean'), 'completed');
                        const child = await ctx.child('child_8').startTurn('cturn_8', { announce: 'turnId' });
                        await child.item(message('cmsg_8', ''), 'started');
                        await child.interrupted;
                        await child.complete('interrupted');
                        await say('stopped')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                let cancelled = false;
                const { events, result } = await drain(session.prompt('go'), async (e) => {
                    if (!cancelled && e.type === 'part-start' && e.parentCallId === 'call_s8') {
                        cancelled = true;
                        await session.cancel({ agentId: 'child_8' });
                    }
                });
                expect(result).toMatchObject({ stopReason: 'end_turn' });
                expect(fake.requests.filter((r) => r.method === 'turn/interrupt').map((r) => r.params)).toEqual([{ threadId: 'child_8', turnId: 'cturn_8' }]);
                const terminal = agentEvents(events, 'child_8').filter((e) => e.type === 'agent-update' && e.status !== 'running');
                expect(terminal.map((e) => (e.type === 'agent-update' ? e.status : ''))).toEqual(['cancelled']);
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });

            it('frames for the session thread that arrive before thread/start answers are delivered to the session, not dropped', async () => {
                const fake = fakeAppServer({
                    onTurn: say('ok'),
                    onThreadStart: async (threadId, notify) => {
                        await notify('thread/name/updated', { threadId, name: 'Early name' });
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                // Everything the session log holds, from its first event.
                const events: AgentEvent[] = [];
                const done = (async () => {
                    for await (const e of session.subscribe({ epoch: 0, seq: 0 })) events.push(e);
                })();
                await drain(session.prompt('go'));
                await session.close();
                await done;
                expect(events.find((e) => e.type === 'ext' && e.name === 'thread/name/updated')).toMatchObject({ data: { name: 'Early name' } });
            });

            it('a cancel that loses the race to the child turn finishing is spent: the next child turn is not interrupted and the agent is not cancelled', async () => {
                const fake = fakeAppServer({
                    onTurn: async (ctx) => {
                        await ctx.item(activity('call_s7', 'started', 'child_7', '/root/race'), 'started');
                        await ctx.item(activity('call_s7', 'started', 'child_7', '/root/race'), 'completed');
                        const first = await ctx.child('child_7').startTurn('cturn_7a');
                        await first.item(message('cmsg_7a', ''), 'started');
                        // The interrupt arrives, but the turn had already finished.
                        await first.interrupted;
                        await first.complete('completed');
                        const second = await ctx.child('child_7').startTurn('cturn_7b');
                        await second.item(message('cmsg_7b', ''), 'started');
                        await second.delta('cmsg_7b', 'done');
                        await second.item(message('cmsg_7b', 'done'), 'completed');
                        await second.complete();
                        await ctx.item(activity('done_7', 'completed', 'child_7', '/root/race'), 'completed');
                        await say('ok')(ctx);
                    }
                });
                const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
                const all = observe(session);
                let cancelled = false;
                const { events, result } = await drain(session.prompt('go'), async (e) => {
                    if (!cancelled && e.type === 'part-start' && e.parentCallId === 'call_s7') {
                        cancelled = true;
                        await session.cancel({ agentId: 'child_7' });
                    }
                });
                expect(result).toMatchObject({ stopReason: 'end_turn' });
                expect(fake.requests.filter((r) => r.method === 'turn/interrupt').map((r) => r.params)).toEqual([{ threadId: 'child_7', turnId: 'cturn_7a' }]);
                const terminal = agentEvents(events, 'child_7').filter((e) => e.type === 'agent-update' && e.status !== 'running');
                expect(terminal.map((e) => (e.type === 'agent-update' ? e.status : ''))).toEqual(['completed']);
                await session.close();
                await all.done;
                checkEventInvariants(all.events);
            });
        });

        it('an interrupted turn cancels the agents still running; closing the session settles the rest', async () => {
            const fake = fakeAppServer({
                onTurn: async (ctx) => {
                    await ctx.item(collab('c1', 'spawnAgent', 'completed', { prompt: 'a', receiverThreadIds: ['r1'], agentsStates: { r1: { status: 'running', message: null } } }), 'completed');
                    await ctx.interrupted;
                    await ctx.complete('interrupted');
                }
            });
            const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
            const { events, result } = await drain(session.prompt('go'), async (e) => {
                if (e.type === 'agent-update' && e.status === 'running') await session.cancel();
            });
            expect(result).toMatchObject({ stopReason: 'cancelled' });
            expect(agentEvents(events, 'r1').map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running', 'cancelled']);

            // A sub-agent can outlive its turn: one still running at `turn/completed` stays running until the session goes.
            const fake2 = fakeAppServer({
                onTurn: async (ctx) => {
                    await ctx.item(collab('c1', 'spawnAgent', 'completed', { prompt: 'a', receiverThreadIds: ['r2'], agentsStates: { r2: { status: 'running', message: null } } }), 'completed');
                    await say('spawned')(ctx);
                }
            });
            const session2 = await codex({ transport: fake2.transport }).session({ cwd: '/repo' });
            const all = observe(session2);
            const second = await drain(session2.prompt('go'));
            expect(agentEvents(second.events, 'r2').map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running']);
            await session2.close();
            await all.done;
            expect(agentEvents(all.events, 'r2').map((e) => (e.type === 'agent-start' ? 'start' : e.status))).toEqual(['start', 'running', 'cancelled']);
            expect(agentEvents(all.events, 'r2').at(-1)).not.toHaveProperty('turnId');
            checkEventInvariants(all.events);
        });
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

    it('a prompt during a turn steers it: turn/steer names the active Codex turn and the input lands as a user-message of the same turn', async () => {
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                const extra = await ctx.nextSteer();
                await say(`Got: ${extra.map((i) => (i.type === 'text' ? i.text : '')).join('')}`)(ctx);
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const first = session.prompt('go');
        // Sent before `turn/start` has answered: the adapter waits for the Codex turn id.
        const second = session.prompt('also B');
        expect(second.id).toBe(first.id);
        const { events, result } = await drain(first);
        const codexTurn = (events.find((e) => e.type === 'ext' && e.name === 'turn') as { data: { turnId: string } }).data.turnId;
        expect(fake.requests.find((r) => r.method === 'turn/steer')?.params).toEqual({ threadId: session.id, expectedTurnId: codexTurn, input: [{ type: 'text', text: 'also B', text_elements: [] }] });
        const users = events.filter((e): e is Extract<AgentEvent, { type: 'user-message' }> => e.type === 'user-message');
        expect(users.map((u) => u.messageId)).toEqual([`u:${first.id}`, `u:${first.id}:1`]);
        expect(users[1]).toMatchObject({ turnId: first.id, parts: [{ type: 'text', text: 'also B' }] });
        expect(textOf(events)).toBe('Got: also B');
        expect(result).toMatchObject({ stopReason: 'end_turn' });
        expect(await second.result).toEqual(result);
        expect(fake.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    });

    it('a steer sent once the turn is under way lands the same way', async () => {
        const fake = fakeAppServer({
            onTurn: async (ctx) => {
                await ctx.nextSteer();
                await say('ok')(ctx);
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const first = session.prompt('go');
        let second: ReturnType<typeof session.prompt> | undefined;
        const { events } = await drain(first, (e) => {
            if (e.type === 'ext' && e.name === 'turn') second = session.prompt('later');
        });
        expect(second?.id).toBe(first.id);
        expect(events.filter((e) => e.type === 'user-message')).toHaveLength(2);
        expect(fake.requests.filter((r) => r.method === 'turn/steer')).toHaveLength(1);
    });

    it('a turn/steer Codex refuses surfaces as a recoverable error inside the turn, which goes on', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const fake = fakeAppServer({
            steer: () => {
                throw Object.assign(new Error('turn mismatch'), { code: -32602 });
            },
            onTurn: async (ctx) => {
                await gate;
                await say('Hello')(ctx);
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const first = session.prompt('go');
        const second = session.prompt('nope');
        const { events, result } = await drain(first, (e) => {
            if (e.type === 'error') release();
        });
        const error = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
        expect(error).toMatchObject({ code: 'protocol_error', recoverable: true, turnId: first.id });
        expect(error?.message).toMatch(/turn\/steer.*turn mismatch/);
        expect(events.filter((e) => e.type === 'user-message')).toHaveLength(1);
        expect(result).toMatchObject({ stopReason: 'end_turn' });
        expect(await second.result).toEqual(result);
    });

    it('a steer Codex answers after the turn already ended is reported at session level, not lost', async () => {
        let started!: (ctx: Parameters<TurnProgram>[0]) => void;
        const running = new Promise<Parameters<TurnProgram>[0]>((r) => (started = r));
        const fake = fakeAppServer({
            // Codex ends the turn before answering the steer: the response lands on an ended turn.
            steer: async (p) => {
                await (await running).complete();
                return { turnId: p.expectedTurnId };
            },
            onTurn: (ctx) => {
                started(ctx);
                return new Promise(() => {});
            }
        });
        const session = await codex({ transport: fake.transport }).session({ cwd: '/repo' });
        const all: AgentEvent[] = [];
        const notice = (async () => {
            for await (const e of session.subscribe({ epoch: 0, seq: 0 })) {
                all.push(e);
                if (e.type === 'error' && e.turnId === undefined) return e;
            }
            return undefined;
        })();
        const first = session.prompt('go');
        const { events, result } = await drain(first, (e) => {
            if (e.type === 'ext' && e.name === 'turn') session.prompt('too late');
        });
        expect(result).toMatchObject({ stopReason: 'end_turn' });
        expect(events.filter((e) => e.type === 'user-message')).toHaveLength(1);
        const error = await notice;
        expect(error).toMatchObject({ code: 'protocol_error', recoverable: true });
        expect(error?.message).toMatch(/arrived after turn .* ended/);
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
        // Refused by the core's promptParts gate before any event, so no turn starts.
        await expect(session.prompt([{ type: 'file', mediaType: 'application/pdf', data: 'AA==' }]).result).rejects.toThrow(/promptParts "text\+image" — file part refused/);
        expect(fake.requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
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
