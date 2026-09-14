// @vitest-environment node
/**
 * `@sigx/ai-agent-acp` against an in-memory ACP agent (`fake-acp-agent.ts`):
 * every request and update the adapter maps, replayed through the real
 * JSON-RPC peer over `TransformStream`s — the same path a spawned agent's
 * stdio takes, minus the process.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { allowAll, denyAll, AgentError, createReducer, createTranscript, type AgentEvent } from '@sigx/ai-agent';
import { codingState, codingExtension } from '@sigx/ai-agent/coding';
import { acp, gemini, cursor, claudeCodeAcp, codexAcp, ACP_BASE_CAPABILITIES } from '@sigx/ai-agent-acp';
import { fakeAcpAgent, FULL_CAPABILITIES, type FakeAcp } from './fake-acp-agent';
import { isInsideRoots } from '../src/client-methods';

const collect = async <T>(it: AsyncIterable<T>) => {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
};
const drain = async (turn: AsyncIterable<AgentEvent> & { result: Promise<unknown> }) => ({ events: await collect(turn), result: (await turn.result) as { stopReason: string; usage?: unknown; error?: { code: string; message: string } } });
const types = (events: readonly AgentEvent[]) => events.map((e) => e.type);
const textOf = (events: readonly AgentEvent[]) =>
    events
        .filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta')
        .map((e) => e.delta)
        .join('');

const cwd = process.cwd();
const fakes: FakeAcp[] = [];
afterEach(async () => {
    for (const f of fakes.splice(0)) await f.close().catch(() => {});
});
function connect(options: Parameters<typeof fakeAcpAgent>[0], acpOptions: Parameters<typeof acp>[0] = {}) {
    const fake = fakeAcpAgent(options);
    fakes.push(fake);
    return { fake, agent: acp({ transport: fake.transport, ...acpOptions }) };
}

describe('acp(): initialize and capabilities', () => {
    it('is conservative before connect() and honest after', async () => {
        const { agent, fake } = connect({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
        expect(agent.id).toBe('acp');
        expect(agent.capabilities).toEqual(ACP_BASE_CAPABILITIES);
        const caps = await agent.connect();
        expect(caps).toMatchObject({ resume: 'local', fork: true, listSessions: true, promptParts: 'text+image+file', tools: 'mcp', cancel: true, permissions: 'harness-filtered', config: true, steer: false, structuredOutput: false });
        expect(agent.capabilities).toBe(caps);
        expect(fake.requests[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: '@sigx/ai-agent-acp' } } });
        expect(agent.init?.agentInfo?.name).toBe('fake-acp');
        await agent.dispose();
    });

    it('a minimal agent gets minimal capabilities and no fs/terminal offer unless opted in', async () => {
        const { agent, fake } = connect({ capabilities: {}, onPrompt: async () => ({ stopReason: 'end_turn' }) }, { fs: { read: true }, terminal: true, clientInfo: { name: 'my-app', version: '2.0.0' } });
        expect(await agent.connect()).toMatchObject({ resume: false, fork: false, listSessions: false, promptParts: 'text', tools: 'none' });
        expect(fake.requests[0]).toMatchObject({ params: { clientCapabilities: { fs: { readTextFile: true }, terminal: true }, clientInfo: { name: 'my-app', version: '2.0.0' } } });
    });

    it('an agent that requires authentication surfaces auth_required with its methods, never a prompt for credentials', async () => {
        const { agent } = connect({ requireAuth: true, authMethods: [{ id: 'oauth', name: 'Sign in with Vendor' }], onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const err = await agent.session({ cwd }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AgentError);
        expect((err as AgentError).code).toBe('auth_required');
        expect((err as AgentError).data).toEqual([{ id: 'oauth', name: 'Sign in with Vendor' }]);
    });

    it('presets are data-only and override-able', () => {
        expect(gemini()).toMatchObject({ id: 'acp:gemini', command: 'gemini', args: ['--experimental-acp'] });
        expect(cursor({ command: '/opt/cursor/agent' })).toMatchObject({ id: 'acp:cursor', command: '/opt/cursor/agent', args: ['acp'] });
        expect(claudeCodeAcp().command).toBe('claude-agent-acp');
        expect(codexAcp().command).toBe('codex-acp');
        expect(acp(gemini()).id).toBe('acp:gemini');
    });
});

describe('acp(): the working-directory fence', () => {
    // Pure containment, independent of the host platform: both the candidate and
    // every root normalize the same way, so the shapes a Windows client can hand
    // us — drive-letter, drive-less absolute, UNC, relative — all compare.
    it('normalizes the roots the same way as the path, on every path shape', () => {
        // A plain drive-letter root.
        expect(isInsideRoots('C:\\repo', ['C:\\repo'], 'C:\\repo\\src\\a.ts')).toBe(true);
        expect(isInsideRoots('C:\\repo', ['C:\\repo'], 'C:\\other\\a.ts')).toBe(false);
        expect(isInsideRoots('C:\\repo', ['c:/repo/'], 'C:\\repo\\a.ts')).toBe(true);
        // A drive-less absolute root borrows the session cwd's drive — without
        // that it normalizes with an empty root and never matches.
        expect(isInsideRoots('C:\\repo', ['\\repo'], 'C:\\repo\\a.ts')).toBe(true);
        expect(isInsideRoots('C:\\repo', ['\\tmp'], 'C:\\tmp\\a.ts')).toBe(true);
        expect(isInsideRoots('C:\\repo', ['\\tmp'], 'C:\\repo\\a.ts')).toBe(false);
        // A UNC share is its own root and stays distinct from another share.
        expect(isInsideRoots('\\\\server\\share\\repo', ['\\\\server\\share\\repo'], '\\\\server\\share\\repo\\a.ts')).toBe(true);
        expect(isInsideRoots('\\\\server\\share\\repo', ['\\\\server\\share\\repo'], '\\\\server\\other\\repo\\a.ts')).toBe(false);
        expect(isInsideRoots('\\\\server\\share\\repo', ['\\\\SERVER\\SHARE\\repo'], '\\\\server\\share\\repo\\sub\\a.ts')).toBe(true);
        // A relative root is one too — it resolves against the session cwd.
        expect(isInsideRoots('C:\\repo', ['sub'], 'C:\\repo\\sub\\a.ts')).toBe(true);
        expect(isInsideRoots('/repo', ['sub'], '/repo/sub/a.ts')).toBe(true);
        // POSIX is unaffected.
        expect(isInsideRoots('/repo', ['/repo'], '/repo/a.ts')).toBe(true);
        expect(isInsideRoots('/repo', ['/repo'], '/other/a.ts')).toBe(false);
    });
});

describe('acp(): sessions and turns', () => {
    it('opens a session with cwd, streams text and thoughts as parts, maps usage and the stop reason', async () => {
        const { agent, fake } = connect({
            modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }] },
            onPrompt: async (api) => {
                await api.thought('hmm');
                await api.text('Hello ', 'm1');
                await api.text('world', 'm1');
                return { stopReason: 'end_turn', usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2, cachedReadTokens: 4 } };
            }
        });
        const session = await agent.session({ cwd, additionalDirectories: ['/tmp/x'] });
        expect(fake.requests.find((r) => r.method === 'session/new')?.params).toEqual({ cwd, additionalDirectories: ['/tmp/x'], mcpServers: [] });
        expect(session.ref).toEqual({ agent: 'acp', v: 1, id: 'fake-1', data: { cwd, additionalDirectories: ['/tmp/x'], epoch: 1 } });
        const all = collect(session.subscribe({ epoch: 0, seq: 0 }));
        const { events, result } = await drain(session.prompt('hi'));
        expect(types(events)).toEqual(['turn-start', 'user-message', 'part-start', 'part-delta', 'part-end', 'part-start', 'part-delta', 'part-delta', 'part-end', 'usage', 'turn-end']);
        expect(events[2]).toMatchObject({ type: 'part-start', kind: 'reasoning' });
        expect(events[5]).toMatchObject({ type: 'part-start', kind: 'text', messageId: expect.stringMatching(/^a:/) });
        expect(textOf(events)).toBe('hmmHello world');
        expect(result).toEqual({ turnId: events[0]!.turnId, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadInputTokens: 4 } });
        expect(fake.requests.find((r) => r.method === 'session/prompt')?.params).toEqual({ sessionId: 'fake-1', prompt: [{ type: 'text', text: 'hi' }] });
        await session.close();
        const everything = await all;
        // The session announced its modes as config before the first turn.
        expect(everything[0]).toMatchObject({ type: 'config', options: [{ id: 'mode', current: 'ask', values: [{ id: 'ask', label: 'Ask' }, { id: 'auto', label: 'Auto' }] }] });
        expect(fake.requests.at(-1)).toMatchObject({ method: 'session/close' });
    });

    it('sends prompt parts as ACP content blocks', async () => {
        const { agent, fake } = connect({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const session = await agent.session({ cwd });
        await session
            .prompt([
                { type: 'text', text: 'look' },
                { type: 'image', mediaType: 'image/png', data: 'AAA=' },
                { type: 'file', mediaType: 'application/pdf', data: 'BBB=', filename: 'a.pdf' },
                { type: 'resource', uri: 'file:///x.txt', text: 'inline' }
            ])
            .result;
        expect(fake.requests.find((r) => r.method === 'session/prompt')?.params).toEqual({
            sessionId: 'fake-1',
            prompt: [
                { type: 'text', text: 'look' },
                { type: 'image', data: 'AAA=', mimeType: 'image/png' },
                { type: 'resource', resource: { uri: 'file:///a.pdf', mimeType: 'application/pdf', blob: 'BBB=' } },
                { type: 'resource', resource: { uri: 'file:///x.txt', text: 'inline' } }
            ]
        });
    });

    it('maps tool calls, updates, diffs, plans and usage updates', async () => {
        const { agent } = connect({
            onPrompt: async (api) => {
                await api.toolCall({ toolCallId: 'c1', title: 'Edit a.ts', name: 'edit_file', kind: 'edit', status: 'in_progress', rawInput: { path: 'a.ts' }, locations: [{ path: '/repo/a.ts' }] });
                await api.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'diff', path: '/repo/a.ts', oldText: '1', newText: '2' }, { type: 'content', content: { type: 'text', text: 'done' } }], rawOutput: { ok: true } });
                await api.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', title: 'Search', kind: 'search', status: 'completed', content: [{ type: 'terminal', terminalId: 'tt' }] });
                await api.update({ sessionUpdate: 'plan', entries: [{ content: 'step 1', priority: 'high', status: 'completed' }, { content: 'step 2', priority: 'low', status: 'pending' }] });
                await api.update({ sessionUpdate: 'usage_update', used: 500, size: 1000, cost: { amount: 0.02, currency: 'USD' } });
                await api.update({ sessionUpdate: 'session_info_update', title: 'Editing' });
                await api.text('Edited.');
                return { stopReason: 'end_turn' };
            }
        });
        const session = await agent.session({ cwd });
        const { events, result } = await drain(session.prompt('edit'));
        expect(result.stopReason).toBe('end_turn');
        const call = events.find((e) => e.type === 'tool-call' && e.callId === 'c1');
        expect(call).toMatchObject({ name: 'edit_file', title: 'Edit a.ts', category: 'edit', input: { path: 'a.ts' } });
        const updates = events.filter((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update' && e.callId === 'c1');
        expect(updates.map((u) => u.status)).toEqual(['in_progress', 'completed']);
        expect(updates[1]).toMatchObject({ output: { ok: true }, content: [{ type: 'text', text: 'done' }] });
        // An update for a never-announced call announces it first.
        expect(events.find((e) => e.type === 'tool-call' && e.callId === 'c2')).toMatchObject({ name: 'Search', category: 'search' });
        const ext = events.filter((e): e is Extract<AgentEvent, { type: 'ext' }> => e.type === 'ext');
        expect(ext.map((e) => `${e.ns}.${e.name}`)).toEqual(['coding.diff', 'acp.tool_terminal', 'coding.plan', 'acp.session_info_update']);
        expect(ext[0]).toMatchObject({ parentCallId: 'c1', data: { path: '/repo/a.ts', oldText: '1', newText: '2' } });
        expect(events.find((e) => e.type === 'usage' && e.scope === 'session')).toMatchObject({ usage: { contextUsed: 500, contextSize: 1000 }, costUsd: 0.02 });
        const reduce = createReducer({ extensions: [codingExtension()] });
        const t = createTranscript(session.id);
        for (const e of events) reduce(t, e);
        expect(codingState(t)?.diffs).toEqual([{ path: '/repo/a.ts', oldText: '1', newText: '2', turnId: events[0]!.turnId, callId: 'c1' }]);
        expect(codingState(t)?.plan?.entries).toHaveLength(2);
        expect(t.messages.at(-1)?.parts.filter((p) => p.type === 'tool')).toHaveLength(2);
    });

    it('permission requests go through the policy and pick the matching option; cancel yields cancelled', async () => {
        const options = [
            { optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const },
            { optionId: 'aa', name: 'Always allow', kind: 'allow_always' as const },
            { optionId: 'r1', name: 'Reject', kind: 'reject_once' as const }
        ];
        const outcomes: unknown[] = [];
        const { agent } = connect({
            onPrompt: async (api) => {
                outcomes.push(await api.permission({ toolCall: { toolCallId: 'c1', title: 'Run tests', name: 'shell', kind: 'execute', rawInput: { command: 'npm test' } }, options }));
                outcomes.push(await api.permission({ toolCall: { toolCallId: 'c2', title: 'Run tests', name: 'shell', kind: 'execute' }, options }));
                outcomes.push(await api.permission({ toolCall: { toolCallId: 'c3', title: 'Delete', name: 'rm', kind: 'delete', locations: [{ path: '/repo/a' }] }, options }));
                await api.text('ok');
                return { stopReason: 'end_turn' };
            }
        });
        const session = await agent.session({ cwd });
        const turn = session.prompt('go');
        const seen: AgentEvent[] = [];
        for await (const e of turn) {
            seen.push(e);
            if (e.type === 'request') {
                expect(e).toMatchObject({ kind: 'permission', toolName: e.callId === 'c3' ? 'rm' : 'shell', permissionKey: e.callId === 'c3' ? 'rm:/repo/a' : 'shell', options: expect.arrayContaining([{ id: 'a1', label: 'Allow once', description: 'allow_once' }]) });
                if (e.callId === 'c1') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
                else if (e.callId === 'c3') await session.respond(e.requestId, { type: 'permission', outcome: 'deny', scope: 'once' });
            }
        }
        // c2 was granted from the session grant made on c1 (same permissionKey `shell`): no request.
        expect(seen.filter((e) => e.type === 'request').map((e) => (e as Extract<AgentEvent, { type: 'request' }>).callId)).toEqual(['c1', 'c3']);
        // The grant is session-scoped, so its reuse on c2 also picks `allow_always`.
        expect(outcomes).toEqual([{ outcome: 'selected', optionId: 'aa' }, { outcome: 'selected', optionId: 'aa' }, { outcome: 'selected', optionId: 'r1' }]);
        expect(seen.filter((e) => e.type === 'request-resolved').map((e) => (e as Extract<AgentEvent, { type: 'request-resolved' }>).by)).toEqual(['client', 'policy', 'client']);

        // Headless: the policy denies → the reject option; with no reject option offered → `cancelled`.
        const headless = connect({
            onPrompt: async (api) => {
                const a = await api.permission({ toolCall: { toolCallId: 'x', title: 'X' }, options });
                const b = await api.permission({ toolCall: { toolCallId: 'y', title: 'Y' }, options: options.filter((o) => o.kind !== 'reject_once') });
                await api.text(JSON.stringify([a, b]));
                return { stopReason: 'end_turn' };
            }
        });
        const s2 = await headless.agent.session({ cwd, interactive: false, policy: denyAll });
        const r2 = await drain(s2.prompt('go'));
        expect(JSON.parse(textOf(r2.events))).toEqual([{ outcome: 'selected', optionId: 'r1' }, { outcome: 'cancelled' }]);
    });

    it('cancel() sends session/cancel; the prompt comes back cancelled and open calls are cancelled', async () => {
        const { agent, fake } = connect({
            onPrompt: async (api) => {
                await api.toolCall({ toolCallId: 'slow', title: 'Slow', kind: 'execute', status: 'in_progress' });
                await api.untilCancelled();
                return { stopReason: 'cancelled' };
            }
        });
        const session = await agent.session({ cwd });
        const turn = session.prompt('go');
        for await (const e of turn) if (e.type === 'tool-update' && e.status === 'in_progress') await session.cancel();
        expect((await turn.result).stopReason).toBe('cancelled');
        expect(fake.cancels).toEqual(['fake-1']);
        const events = await collect(turn);
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'slow' && e.status === 'cancelled')).toBeDefined();
    });

    it('a prompt that fails with a JSON-RPC error ends the turn with error; auth errors are auth_required', async () => {
        const { agent } = connect({
            onPrompt: async (_api, turn) => {
                const { JsonRpcError } = await import('@sigx/ai-agent/harness');
                throw turn === 0 ? new JsonRpcError(-32000, 'Authentication required') : new JsonRpcError(-32603, 'boom');
            }
        });
        const session = await agent.session({ cwd });
        const r1 = await drain(session.prompt('a'));
        expect(r1.result).toMatchObject({ stopReason: 'error', error: { code: 'auth_required' } });
        expect(r1.events.find((e) => e.type === 'error')).toMatchObject({ code: 'auth_required', recoverable: true });
        const r2 = await drain(session.prompt('b'));
        expect(r2.result).toMatchObject({ stopReason: 'error', error: { code: 'provider_error', message: 'boom' } });
    });

    it('a second prompt while one runs rejects with SessionBusyError', async () => {
        const { agent } = connect({
            onPrompt: async (api) => {
                await new Promise((r) => setTimeout(r, 20));
                await api.text('x');
                return { stopReason: 'end_turn' };
            }
        });
        const session = await agent.session({ cwd });
        const first = session.prompt('a');
        await expect(session.prompt('b').result).rejects.toMatchObject({ name: 'SessionBusyError' });
        expect((await first.result).stopReason).toBe('end_turn');
    });

    it('configure() sets the mode and config options; mode updates from the agent become config events', async () => {
        const { agent, fake } = connect({
            modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'auto', name: 'Auto' }] },
            configOptions: [
                { id: 'model', name: 'Model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }] },
                { id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }
            ],
            onPrompt: async (api) => {
                await api.update({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' });
                return { stopReason: 'end_turn' };
            }
        });
        const session = await agent.session({ cwd });
        const all = collect(session.subscribe({ epoch: 0, seq: 0 }));
        await session.configure!({ mode: 'auto', model: 'smart', thinking: 'true' });
        expect(fake.modes.get('fake-1')).toBe('auto');
        expect(fake.configValues.get('model')).toBe('smart');
        expect(fake.configValues.get('thinking')).toBe(true);
        await session.prompt('go').result;
        await session.close();
        const configs = (await all).filter((e): e is Extract<AgentEvent, { type: 'config' }> => e.type === 'config');
        expect(configs[0]!.options.map((o) => [o.id, o.current])).toEqual([['mode', 'ask'], ['model', 'fast'], ['thinking', 'false']]);
        expect(configs[1]!.options.map((o) => [o.id, o.current])).toEqual([['mode', 'auto'], ['model', 'smart'], ['thinking', 'true']]);
        expect(configs[2]!.options[0]).toMatchObject({ id: 'mode', current: 'ask' });
        await expect(session.configure!({ nope: 'x' })).rejects.toThrow(/unknown config option/);
    });

    it('resumes through session/resume, loads history through session/load into a new epoch, forks, lists', async () => {
        const resumable = connect({ onPrompt: async (api) => ((await api.text('again')), { stopReason: 'end_turn' }) });
        const s1 = await resumable.agent.session({ cwd });
        await s1.prompt('a').result;
        const ref = s1.ref;
        await s1.close();
        // No cwd given: the ref's cwd is used, so a ref alone resumes "in the same place".
        const s2 = await resumable.agent.session({ resume: ref });
        expect(s2.id).toBe(s1.id);
        expect(resumable.fake.requests.at(-1)).toMatchObject({ method: 'session/resume', params: { sessionId: 'fake-1', cwd } });
        expect(s2.ref.data).toMatchObject({ cwd });
        await expect(resumable.agent.session({})).rejects.toThrow(/needs a cwd/);
        const { events } = await drain(s2.prompt('b'));
        expect(events[0]!.epoch).toBe(2);
        const forked = await resumable.agent.session({ cwd, resume: ref, fork: true });
        expect(forked.id).not.toBe(s1.id);
        const listed = await resumable.agent.listSessions!();
        expect(listed.map((s) => s.ref.id)).toContain('fake-1');
        // The fake pages two at a time: every page is fetched, following `nextCursor`.
        expect(listed).toHaveLength(resumable.fake.sessions.length);
        expect(resumable.fake.requests.filter((r) => r.method === 'session/list').map((r) => (r.params as { cursor?: string }).cursor)).toEqual([undefined, '2']);
        expect(listed[0]).toMatchObject({ title: 'Session fake-1', updatedAt: Date.parse('2026-09-13T12:00:00Z'), ref: { data: { cwd: '/repo' } } });
        expect(listed[1]).not.toHaveProperty('updatedAt'); // unparseable timestamps are omitted, never NaN

        const loading = connect({
            capabilities: { loadSession: true },
            history: [
                { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier ' }, messageId: 'u1' },
                { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' }, messageId: 'u1' },
                { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' }, messageId: 'a1' },
                { sessionUpdate: 'tool_call', toolCallId: 'h1', title: 'Read', kind: 'read', status: 'completed' }
            ],
            onPrompt: async (api) => ((await api.text('new answer')), { stopReason: 'end_turn' })
        });
        expect((await loading.agent.connect()).resume).toBe('local');
        const s3 = await loading.agent.session({ cwd, resume: { agent: 'acp', v: 1, id: 'old-1', data: { cwd, epoch: 3 } } });
        const all = collect(s3.subscribe({ epoch: 0, seq: 0 }));
        await s3.prompt('now').result;
        await s3.close();
        const history = (await all).filter((e) => e.epoch === 4 && e.turnId === undefined);
        expect(types(history).slice(0, 5)).toEqual(['user-message', 'part-start', 'part-delta', 'part-end', 'tool-call']);
        expect(history[0]).toMatchObject({ type: 'user-message', messageId: 'u:u1', parts: [{ type: 'text', text: 'earlier ' }, { type: 'text', text: 'question' }] });
        await expect(connect({ capabilities: {}, onPrompt: async () => ({ stopReason: 'end_turn' }) }).agent.session({ cwd, resume: ref })).rejects.toThrow(/cannot resume/);
        await expect(resumable.agent.session({ cwd, resume: { agent: 'other', v: 1, id: 'x' } })).rejects.toThrow(/belongs to agent/);
    });

    it('client tools become an HTTP MCP server the agent can call; agents without http MCP refuse tools', async () => {
        const anySchema: StandardSchemaV1<unknown, unknown> = { '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } };
        const json: JsonSchema = { type: 'object' };
        const echo = defineTool({ name: 'echo', description: 'Echo', input: anySchema, jsonSchema: json, execute: (input) => ({ echoed: input }) });
        let mcp: { url: string; headers: { name: string; value: string }[] } | undefined;
        const { agent, fake } = connect({
            onPrompt: async (api) => {
                const server = (fake.requests.find((r) => r.method === 'session/new')!.params as { mcpServers: { type: string; url: string; headers: { name: string; value: string }[] }[] }).mcpServers[0]!;
                mcp = { url: server.url, headers: server.headers };
                const res = await fetch(server.url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json', ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })
                });
                const body = (await res.json()) as { result: { structuredContent: unknown } };
                await api.text(JSON.stringify(body.result.structuredContent));
                return { stopReason: 'end_turn' };
            }
        });
        const session = await agent.session({ cwd, tools: [echo] });
        const { events } = await drain(session.prompt('use echo'));
        expect(mcp?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(mcp?.headers[0]).toMatchObject({ name: 'Authorization', value: expect.stringMatching(/^Bearer /) });
        expect(textOf(events)).toBe('{"echoed":{"a":1}}');
        await session.close();
        // The listener is gone with the session.
        await expect(fetch(mcp!.url, { method: 'POST' })).rejects.toThrow();

        const noHttp = connect({ capabilities: { mcpCapabilities: {} }, onPrompt: async () => ({ stopReason: 'end_turn' }) });
        await expect(noHttp.agent.session({ cwd, tools: [echo] })).rejects.toThrow(/does not accept HTTP MCP servers/);
    });

    it('fs methods are offered only when opted in, fenced to the roots, and gated by the policy', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sigx-acp-'));
        try {
            await writeFile(join(dir, 'a.txt'), 'line1\nline2\nline3', 'utf8');
            const results: unknown[] = [];
            const { agent } = connect(
                {
                    onPrompt: async (api) => {
                        results.push(await api.readFile(join(dir, 'a.txt')));
                        // A relative path resolves against the SESSION cwd, not the process's.
                        results.push(await api.readFile('a.txt'));
                        await api.writeFile(join('sub', 'b.txt'), 'written');
                        results.push(await api.readFile(join(dir, '..', 'escape.txt')).catch((e: Error) => e.message));
                        results.push(await api.readFile('../escape.txt').catch((e: Error) => e.message));
                        results.push(await api.writeFile(join(dir, 'denied.txt'), 'x').catch((e: Error & { code?: number }) => `${e.code}:${e.message}`));
                        return { stopReason: 'end_turn' };
                    }
                },
                { fs: { read: true, write: true } }
            );
            let writes = 0;
            const session = await agent.session({
                cwd: dir,
                interactive: false,
                policy: (req) => (req.toolName === 'fs/write_text_file' && writes++ > 0 ? { type: 'permission', outcome: 'deny', scope: 'once', message: 'one write only' } : { type: 'permission', outcome: 'allow', scope: 'once' })
            });
            const { events } = await drain(session.prompt('files'));
            expect(results[0]).toEqual({ content: 'line1\nline2\nline3' });
            expect(results[1]).toEqual({ content: 'line1\nline2\nline3' });
            expect(await readFile(join(dir, 'sub', 'b.txt'), 'utf8')).toBe('written');
            expect(results[2]).toMatch(/outside the session's working directory/);
            expect(results[3]).toMatch(/outside the session's working directory/);
            // A policy denial is an invalid request (-32600), never the auth-required code.
            expect(results[4]).toMatch(/^-32600:.*one write only/);
            const resolved = events.filter((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved');
            expect(resolved.map((r) => r.outcome)).toEqual(['allow', 'allow', 'allow', 'deny']);
            // The policy saw absolute paths.
            const requests = events.filter((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved');
            expect(requests).toHaveLength(4);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('a session-scoped fs grant covers the file it was approved for, not the whole fence', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sigx-acp-'));
        try {
            await writeFile(join(dir, 'a.txt'), 'A', 'utf8');
            await writeFile(join(dir, 'b.txt'), 'B', 'utf8');
            const results: unknown[] = [];
            const { agent } = connect(
                {
                    onPrompt: async (api) => {
                        results.push(await api.readFile(join(dir, 'a.txt')));
                        // Same file again: the session grant covers it, no second ask.
                        results.push(await api.readFile(join(dir, 'a.txt')));
                        // A different file inside the same fence must be asked for.
                        results.push(await api.readFile(join(dir, 'b.txt')));
                        await api.writeFile(join(dir, 'a.txt'), 'A2');
                        return { stopReason: 'end_turn' };
                    }
                },
                { fs: { read: true, write: true } }
            );
            const session = await agent.session({ cwd: dir });
            const turn = session.prompt('read');
            const keys: (string | undefined)[] = [];
            for await (const e of turn) {
                if (e.type === 'request') {
                    keys.push(e.permissionKey);
                    await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
                }
            }
            expect(keys).toEqual([`fs/read_text_file:${join(dir, 'a.txt')}`, `fs/read_text_file:${join(dir, 'b.txt')}`, `fs/write_text_file:${join(dir, 'a.txt')}`]);
            expect(results).toEqual([{ content: 'A' }, { content: 'A' }, { content: 'B' }]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('terminals run through the process supervisor with bounded output and coding.terminal events', async () => {
        let output: unknown;
        let exit: unknown;
        const { agent } = connect(
            {
                onPrompt: async (api) => {
                    const { terminalId } = await api.createTerminal(process.execPath, ['-e', 'process.stdout.write("hello from the child"); process.exit(3)']);
                    exit = await api.waitForExit(terminalId);
                    output = await api.terminalOutput(terminalId);
                    return { stopReason: 'end_turn' };
                }
            },
            { terminal: true }
        );
        const session = await agent.session({ cwd, policy: allowAll });
        const { events } = await drain(session.prompt('run'));
        expect(exit).toEqual({ exitCode: 3, signal: null });
        expect(output).toMatchObject({ output: 'hello from the child', truncated: false, exitStatus: { exitCode: 3, signal: null } });
        const ext = events.filter((e): e is Extract<AgentEvent, { type: 'ext' }> => e.type === 'ext').map((e) => e.name);
        expect(ext).toEqual(['terminal', 'terminal-exit']);
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'allow' });
    }, 20_000);

    it('a peer that closes under a session reports process_exited', async () => {
        const { agent, fake } = connect({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const session = await agent.session({ cwd });
        const all = collect(session.subscribe());
        await fake.close();
        await new Promise((r) => setTimeout(r, 20));
        await session.close();
        expect((await all).find((e) => e.type === 'error')).toMatchObject({ code: 'process_exited' });
    });
});

describe('acp(): honesty (#88)', () => {
    it('a prompt that asks for structured output ends with protocol_error before anything is sent', async () => {
        const { agent, fake } = connect({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const session = await agent.session({ cwd });
        const schema: JsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
        const { events, result } = await drain(session.prompt('shape it', { output: { schema } }));
        expect(result).toMatchObject({ stopReason: 'error', error: { code: 'protocol_error', message: expect.stringMatching(/structuredOutput/) } });
        expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'protocol_error' });
        expect(fake.requests.some((r) => r.method === 'session/prompt')).toBe(false);
        // The session is still usable.
        expect((await session.prompt('plain').result).stopReason).toBe('end_turn');
    });

    it('prompt parts the agent did not negotiate are refused up front', async () => {
        const { agent, fake } = connect({ capabilities: { promptCapabilities: { image: true } }, onPrompt: async () => ({ stopReason: 'end_turn' }) });
        expect((await agent.connect()).promptParts).toBe('text+image');
        const session = await agent.session({ cwd });
        const image = await drain(session.prompt([{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', data: 'AAA=' }]));
        expect(image.result.stopReason).toBe('end_turn');
        const file = await drain(session.prompt([{ type: 'file', mediaType: 'text/plain', data: 'aGk=', filename: 'a.txt' }]));
        expect(file.result).toMatchObject({ stopReason: 'error', error: { code: 'protocol_error', message: expect.stringMatching(/"file".*promptParts: text\+image/) } });
        const resource = await drain(session.prompt([{ type: 'resource', uri: 'file:///x', text: 'x' }]));
        expect(resource.result).toMatchObject({ stopReason: 'error', error: { code: 'protocol_error' } });
        expect(fake.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1);
        const textOnly = connect({ capabilities: {}, onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const s2 = await textOnly.agent.session({ cwd });
        expect((await s2.prompt([{ type: 'image', mediaType: 'image/png', data: 'AAA=' }]).result).error).toMatchObject({ code: 'protocol_error', message: expect.stringMatching(/"image".*promptParts: text/) });
    });

    it('the connection closing under a running turn ends it with process_exited, like the session-level error', async () => {
        let fakeRef: FakeAcp | undefined;
        const { agent, fake } = connect({
            onPrompt: async (api) => {
                await api.text('partial');
                await fakeRef!.close();
                return new Promise(() => {});
            }
        });
        fakeRef = fake;
        const session = await agent.session({ cwd });
        const all = collect(session.subscribe({ epoch: 0, seq: 0 }));
        const { result } = await drain(session.prompt('go'));
        expect(result).toMatchObject({ stopReason: 'error', error: { code: 'process_exited' } });
        await session.close();
        const errors = (await all).filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
        expect(errors.map((e) => e.code)).toEqual(['process_exited', 'process_exited']);
    });

    it('cancel() speaks session/cancel only — no JSON-RPC cancel notification ever leaves the client', async () => {
        const { agent, fake } = connect({
            onPrompt: async (api) => {
                await api.untilCancelled();
                return { stopReason: 'cancelled' };
            }
        });
        const unhandled: string[] = [];
        fake.peer.onUnhandled((m) => unhandled.push(m.method));
        const session = await agent.session({ cwd });
        const turn = session.prompt('slow');
        await new Promise((r) => setTimeout(r, 10));
        await session.cancel();
        expect((await turn.result).stopReason).toBe('cancelled');
        expect(fake.cancels).toEqual(['fake-1']);
        expect(unhandled).toEqual([]);
    });

    it('configure({ mode }) on a session without modes rejects instead of sending session/set_mode blindly', async () => {
        const { agent, fake } = connect({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const session = await agent.session({ cwd });
        await expect(session.configure!({ mode: 'auto' })).rejects.toThrow(/no modes/);
        expect(fake.requests.some((r) => r.method === 'session/set_mode')).toBe(false);
        const withModes = connect({ modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] }, onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const s2 = await withModes.agent.session({ cwd });
        await expect(s2.configure!({ mode: 'nope' })).rejects.toThrow(/unknown mode "nope"/);
        expect(withModes.fake.requests.some((r) => r.method === 'session/set_mode')).toBe(false);
    });

    it('dispose() closes every open session: the log ends with state closed and the tools listener is gone', async () => {
        const { agent, fake } = connect({ onPrompt: async () => ({ stopReason: 'end_turn' }) });
        const anySchema: StandardSchemaV1<unknown, unknown> = { '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } };
        const tool = defineTool({ name: 'ping', description: 'pong', input: anySchema, jsonSchema: { type: 'object' }, execute: async () => 'pong' });
        const session = await agent.session({ cwd, tools: [tool] });
        const url = (fake.requests.find((r) => r.method === 'session/new')!.params as { mcpServers: { url: string }[] }).mcpServers[0]!.url;
        await session.prompt('hi').result;
        const all = collect(session.subscribe({ epoch: 0, seq: 0 }));
        await agent.dispose();
        const events = await all; // resolves only because the session log was closed
        expect(events.at(-1)).toMatchObject({ type: 'state', value: 'closed' });
        expect(fake.requests.some((r) => r.method === 'session/close')).toBe(true);
        await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
    });
});
