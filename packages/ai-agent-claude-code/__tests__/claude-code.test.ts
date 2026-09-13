// @vitest-environment node
/**
 * `@sigx/ai-agent-claude-code` — recorded SDK messages replayed through a fake
 * `query` (mirrors the provider packages' fake-client pattern), the conformance
 * suite over the same fake, and an env-gated live smoke against the real CLI.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { defineTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { allowAll, allowReadOnly, denyAll, type AgentEvent, type AgentTurn } from '@sigx/ai-agent';
import { agentConformance, type ConformanceScenario } from '@sigx/ai-agent/testing';
import { codingState, codingExtension } from '@sigx/ai-agent/coding';
import { createReducer, createTranscript } from '@sigx/ai-agent';
import { claudeCode, CLAUDE_CODE_CAPABILITIES, splitToolName, primaryArg, toUserMessage, spawnForSdk, type ListenFn } from '@sigx/ai-agent-claude-code';

// ── recorded frames ─────────────────────────────────────────────────────────

const SESSION = 'sess-1';
const base = { session_id: SESSION, uuid: 'u' } as const;
const m = (v: unknown) => v as SDKMessage;

const INIT = (cwd: string, model = 'claude-opus-5') =>
    m({ type: 'system', subtype: 'init', ...base, cwd, model, permissionMode: 'default', tools: ['Read', 'Edit'], mcp_servers: [], apiKeySource: 'none', claude_code_version: '2.1.270', slash_commands: [], output_style: 'default', skills: [], plugins: [], agents: [] });

const ev = (event: unknown, parent: string | null = null) => m({ type: 'stream_event', ...base, event, parent_tool_use_id: parent });
const textBlocks = (text: string, parent: string | null = null, index = 0): SDKMessage[] => [
    ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, parent),
    ...text.split(' ').map((w, i, arr) => ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: i < arr.length - 1 ? `${w} ` : w } }, parent)),
    ev({ type: 'content_block_stop', index }, parent)
];
const messageStart = (parent: string | null = null) => ev({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }, parent);
const messageStop = (parent: string | null = null) => [ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, parent), ev({ type: 'message_stop' }, parent)];
const thinkingBlocks = (): SDKMessage[] => [
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig==' } }),
    ev({ type: 'content_block_stop', index: 0 })
];
const toolUseBlocks = (id: string, name: string, input: object, index = 0, parent: string | null = null): SDKMessage[] => {
    const json = JSON.stringify(input);
    const half = Math.ceil(json.length / 2);
    return [
        ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }, parent),
        ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } }, parent),
        ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(half) } }, parent),
        ev({ type: 'content_block_stop', index }, parent)
    ];
};
const toolResult = (id: string, content: string, isError = false, parent: string | null = null) =>
    m({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: parent });
const progress = (id: string, name: string) => m({ type: 'tool_progress', ...base, tool_use_id: id, tool_name: name, parent_tool_use_id: null, elapsed_time_seconds: 1 });
const RESULT = (extra: Record<string, unknown> = {}) =>
    m({
        type: 'result',
        subtype: 'success',
        ...base,
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        result: 'done',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
        modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0, costUSD: 0.01 } },
        permission_denials: [],
        ...extra
    });
const RESULT_ERROR = (subtype: string, extra: Record<string, unknown> = {}) =>
    m({ type: 'result', subtype, ...base, duration_ms: 10, duration_api_ms: 8, is_error: true, num_turns: 1, stop_reason: null, total_cost_usd: 0.02, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], errors: ['it broke'], ...extra });

// ── the fake query ──────────────────────────────────────────────────────────

interface TurnCtx {
    readonly options: Options;
    readonly interrupted: () => boolean;
    readonly onInterrupt: Promise<void>;
    /** Ask the host's canUseTool the way the CLI would. */
    ask(name: string, input: object, toolUseID?: string): Promise<{ behavior: 'allow' | 'deny'; message?: string }>;
}
type TurnScript = (user: SDKUserMessage, turn: number, ctx: TurnCtx) => AsyncIterable<SDKMessage> | Iterable<SDKMessage> | Promise<Iterable<SDKMessage>>;

interface FakeQuery {
    readonly query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
    readonly calls: Options[];
    readonly interrupts: number;
    readonly closes: number;
    readonly models: string[];
}

function fakeQuery(turnScript: TurnScript, options: { init?: (cwd: string) => SDKMessage; exitAfterTurns?: number } = {}): FakeQuery {
    const state = { calls: [] as Options[], interrupts: 0, closes: 0, models: [] as string[] };
    const query: FakeQuery['query'] = ({ prompt, options: opts = {} }) => {
        state.calls.push(opts);
        let interrupted = false;
        let resolveInterrupt!: () => void;
        let onInterrupt = new Promise<void>((r) => (resolveInterrupt = r));
        let closed = false;
        const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
            yield (options.init ?? INIT)(opts.cwd ?? '');
            let turn = 0;
            if (typeof prompt === 'string') return;
            for await (const user of prompt) {
                if (closed) return;
                if (options.exitAfterTurns !== undefined && turn >= options.exitAfterTurns) return;
                const ctx: TurnCtx = {
                    options: opts,
                    interrupted: () => interrupted,
                    onInterrupt,
                    ask: async (name, input, toolUseID) => {
                        const r = (await opts.canUseTool!(name, input as Record<string, unknown>, { signal: new AbortController().signal, suggestions: [], ...(toolUseID ? { toolUseID } : {}) } as never)) as unknown as
                            | { behavior: 'allow' }
                            | { behavior: 'deny'; message: string };
                        return r.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: r.message };
                    }
                };
                const script = await turnScript(user, turn++, ctx);
                for await (const msg of script) {
                    if (closed) return;
                    yield msg;
                }
                interrupted = false;
                onInterrupt = new Promise<void>((r) => (resolveInterrupt = r));
            }
        })();
        const q = Object.assign(gen, {
            interrupt: async () => {
                state.interrupts++;
                interrupted = true;
                resolveInterrupt();
                return undefined;
            },
            setPermissionMode: async () => {},
            setModel: async (model?: string) => {
                state.models.push(model ?? '');
            },
            close: () => {
                state.closes++;
                closed = true;
            }
        });
        return q as unknown as Query;
    };
    return {
        query,
        get calls() {
            return state.calls;
        },
        get interrupts() {
            return state.interrupts;
        },
        get closes() {
            return state.closes;
        },
        get models() {
            return state.models;
        }
    };
}

const fakeListen: ListenFn = async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok', headers: { Authorization: 'Bearer tok' }, server: undefined as never, close: async () => {} });

const cwd = 'C:\\work\\repo';

async function drain(turn: AgentTurn, onEvent?: (e: AgentEvent) => Promise<void> | void) {
    const events: AgentEvent[] = [];
    for await (const e of turn) {
        events.push(e);
        if (onEvent) await onEvent(e);
    }
    return { events, result: await turn.result };
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const textOf = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta' && !e.parentCallId).map((e) => e.delta).join('');

// ── tests ───────────────────────────────────────────────────────────────────

describe('@sigx/ai-agent-claude-code (recorded)', () => {
    it('declares capabilities, maps init to config and a streamed text + thinking turn to parts and a result', async () => {
        const fake = fakeQuery(() => [messageStart(), ...thinkingBlocks(), ...textBlocks('Hello brave world', null, 1), ...messageStop(), RESULT()]);
        const agent = claudeCode({ query: fake.query, listen: fakeListen });
        expect(agent.id).toBe('claude-code');
        expect(agent.capabilities).toEqual(CLAUDE_CODE_CAPABILITIES);
        const session = await agent.session({ cwd, system: 'be brief', model: 'claude-opus-5', maxTurns: 3, interactive: false });
        const { events, result } = await drain(session.prompt('hi'));
        expect(types(events)).toEqual(['turn-start', 'user-message', 'config', 'part-start', 'part-delta', 'part-end', 'part-start', 'part-delta', 'part-delta', 'part-delta', 'part-end', 'usage', 'usage', 'turn-end']);
        expect(events[2]).toMatchObject({ type: 'config', options: [{ id: 'model', current: 'claude-opus-5' }, { id: 'permissionMode', current: 'default' }] });
        expect(events[5]).toMatchObject({ type: 'part-end', providerData: { type: 'thinking', thinking: 'hmm', signature: 'sig==' } });
        expect(textOf(events)).toBe('hmmHello brave world');
        expect(events[11]).toMatchObject({ type: 'usage', scope: 'turn', usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 }, costUsd: 0.01 });
        expect(events[12]).toMatchObject({ type: 'usage', scope: 'session', costUsd: 0.01, usage: { inputTokens: 10 } });
        expect(result).toMatchObject({ stopReason: 'end_turn', costUsd: 0.01, usage: { inputTokens: 10 } });
        expect(session.ref).toEqual({ agent: 'claude-code', v: 1, id: SESSION, data: { cwd, epoch: 1 } });
        // The options the SDK saw.
        const opts = fake.calls[0]!;
        expect(opts).toMatchObject({ cwd, model: 'claude-opus-5', systemPrompt: 'be brief', settingSources: [], permissionMode: 'default', includePartialMessages: true, maxTurns: 3 });
        expect(opts.mcpServers).toBeUndefined();
        expect(opts.env).toBeDefined();
        expect(opts.env!.NODE_OPTIONS).toBeUndefined();
        expect(typeof opts.canUseTool).toBe('function');
        expect(typeof opts.spawnClaudeCodeProcess).toBe('function');
        // A second turn reuses the query; cost is a delta.
        const second = await drain(session.prompt('again'));
        expect(fake.calls).toHaveLength(1);
        expect(second.result.costUsd).toBe(0);
        await agent.dispose();
        expect(fake.closes).toBe(1);
    });

    it('tool use: partial JSON reassembled, permission asked through the policy, Edit becomes a coding.diff, denial reads denied', async () => {
        const fake = fakeQuery(async function* (_user, _turn, ctx) {
            yield messageStart();
            yield* toolUseBlocks('toolu_1', 'Edit', { file_path: 'C:\\work\\repo\\a.ts', old_string: 'a', new_string: 'b' });
            yield* messageStop();
            const first = await ctx.ask('Edit', { file_path: 'C:\\work\\repo\\a.ts', old_string: 'a', new_string: 'b' });
            yield progress('toolu_1', 'Edit');
            yield toolResult('toolu_1', first.behavior === 'allow' ? 'edited' : (first.message ?? 'denied'), first.behavior === 'deny');
            yield messageStart();
            yield* toolUseBlocks('toolu_2', 'Bash', { command: 'rm -rf /' });
            yield* messageStop();
            const second = await ctx.ask('Bash', { command: 'rm -rf /' });
            yield toolResult('toolu_2', second.message ?? 'ran', second.behavior === 'deny');
            yield messageStart();
            yield* textBlocks('Done.');
            yield* messageStop();
            yield RESULT();
        });
        const agent = claudeCode({ query: fake.query, listen: fakeListen });
        const session = await agent.session({ cwd, policy: denyAll });
        // Interactive session, but the policy decides: nothing is asked of the client.
        const { events, result } = await drain(session.prompt('edit a.ts'));
        expect(events.find((e) => e.type === 'tool-call' && e.callId === 'toolu_1')).toMatchObject({ name: 'Edit', category: 'edit', input: { file_path: 'C:\\work\\repo\\a.ts', old_string: 'a', new_string: 'b' } });
        const updates = events.filter((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update');
        expect(updates.filter((u) => u.callId === 'toolu_1').map((u) => u.status)).toEqual(['pending', 'in_progress', 'denied']);
        expect(updates.filter((u) => u.callId === 'toolu_2').map((u) => u.status)).toEqual(['pending', 'denied']);
        const resolved = events.filter((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved');
        expect(resolved.map((r) => [r.outcome, r.by, r.ruleId])).toEqual([
            ['deny', 'policy', 'denyAll'],
            ['deny', 'policy', 'denyAll']
        ]);
        expect(events.filter((e) => e.type === 'request')).toHaveLength(0);
        expect(events.find((e) => e.type === 'ext')).toBeUndefined(); // a denied edit changed nothing
        expect(result.stopReason).toBe('end_turn');

        // Allowed by the client, with a session grant reused on the next ask.
        const allowing = claudeCode({ query: fakeQuery(async function* (_u, _t, ctx) {
            yield messageStart();
            yield* toolUseBlocks('toolu_1', 'Edit', { file_path: 'C:\\work\\repo\\a.ts', old_string: 'a', new_string: 'b' });
            yield* messageStop();
            await ctx.ask('Edit', { file_path: 'C:\\work\\repo\\a.ts', old_string: 'a', new_string: 'b' });
            yield toolResult('toolu_1', 'edited');
            yield messageStart();
            yield* toolUseBlocks('toolu_2', 'Edit', { file_path: 'C:\\work\\repo\\a.ts', old_string: 'b', new_string: 'c' });
            yield* messageStop();
            await ctx.ask('Edit', { file_path: 'C:\\work\\repo\\a.ts', old_string: 'b', new_string: 'c' });
            yield toolResult('toolu_2', 'edited');
            yield RESULT();
        }).query, listen: fakeListen });
        const s2 = await allowing.session({ cwd });
        const seen = await drain(s2.prompt('edit twice'), async (e) => {
            if (e.type === 'request') {
                expect(e).toMatchObject({ kind: 'permission', toolName: 'Edit', callId: 'toolu_1', permissionKey: 'Edit:C:\\work\\repo\\a.ts' });
                await s2.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
            }
        });
        expect(seen.events.filter((e) => e.type === 'request')).toHaveLength(1);
        expect(seen.events.filter((e) => e.type === 'request-resolved').map((e) => (e as Extract<AgentEvent, { type: 'request-resolved' }>).by)).toEqual(['client', 'policy']);
        const diffs = seen.events.filter((e) => e.type === 'ext' && e.ns === 'coding' && e.name === 'diff');
        expect(diffs).toHaveLength(2);
        expect(diffs[0]).toMatchObject({ parentCallId: 'toolu_1', data: { path: 'C:\\work\\repo\\a.ts', oldText: 'a', newText: 'b' } });
        const t = createTranscript(s2.id);
        const reduce = createReducer({ extensions: [codingExtension()] });
        for (const e of seen.events) reduce(t, e);
        expect(codingState(t)?.diffs.map((d) => d.callId)).toEqual(['toolu_1', 'toolu_2']);
        expect(codingState(t)?.filesChanged).toEqual(['C:\\work\\repo\\a.ts']);
    });

    it('subagent frames carry parentCallId and actor; client tools arrive over MCP with the prefix stripped', async () => {
        const echo = defineTool({ name: 'echo', description: 'echo', input: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } } as StandardSchemaV1, jsonSchema: { type: 'object' } as JsonSchema, execute: (i) => i });
        const fake = fakeQuery(async function* (_u, _t, ctx) {
            yield messageStart();
            yield* toolUseBlocks('task_1', 'Task', { description: 'research' });
            yield* messageStop();
            await ctx.ask('Task', { description: 'research' });
            yield messageStart('task_1');
            yield* textBlocks('found it', 'task_1');
            yield* messageStop('task_1');
            yield messageStart('task_1');
            yield* toolUseBlocks('toolu_9', 'mcp__sigx-tools__echo', { x: 1 }, 0, 'task_1');
            yield* messageStop('task_1');
            const r = await ctx.ask('mcp__sigx-tools__echo', { x: 1 });
            yield toolResult('toolu_9', r.behavior, r.behavior === 'deny', 'task_1');
            yield toolResult('task_1', 'summary');
            yield RESULT();
        });
        const agent = claudeCode({ query: fake.query, listen: fakeListen });
        const session = await agent.session({ cwd, tools: [echo], policy: allowAll });
        expect(fake.calls).toHaveLength(0);
        const { events } = await drain(session.prompt('go'));
        expect(fake.calls[0]!.mcpServers).toEqual({ 'sigx-tools': { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer tok' } } });
        const nested = events.filter((e) => e.parentCallId === 'task_1');
        // The request resolution is a session-level decision, not part of the nested work.
        expect(nested.map((e) => e.type)).toEqual(['part-start', 'part-delta', 'part-delta', 'part-end', 'tool-call', 'tool-update', 'tool-update']);
        expect(nested[0]).toMatchObject({ actor: 'subagent' });
        expect(nested.find((e) => e.type === 'tool-call')).toMatchObject({ callId: 'toolu_9', name: 'echo', input: { x: 1 } });
        const asks = events.filter((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved');
        expect(asks).toHaveLength(2);
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'task_1' && e.status === 'completed')).toMatchObject({ output: 'summary' });
    });

    it('maps result subtypes, interrupts, context overflow, assistant and auth errors', async () => {
        const run = async (script: TurnScript, sessionOptions: Record<string, unknown> = {}) => {
            const fake = fakeQuery(script);
            const agent = claudeCode({ query: fake.query, listen: fakeListen });
            const session = await agent.session({ cwd, interactive: false, ...sessionOptions });
            return { fake, session };
        };
        const maxTurns = await run(() => [RESULT_ERROR('error_max_turns')]);
        expect((await maxTurns.session.prompt('x').result).stopReason).toBe('max_turns');

        const failed = await run(() => [RESULT_ERROR('error_during_execution')]);
        const f = await drain(failed.session.prompt('x'));
        expect(f.result).toMatchObject({ stopReason: 'error', error: { code: 'provider_error', message: 'it broke' } });

        const budget = await run(() => [RESULT_ERROR('error_max_budget_usd', { errors: [] })]);
        expect((await budget.session.prompt('x').result).error?.message).toMatch(/error_max_budget_usd/);

        const tooLong = await run(() => [RESULT_ERROR('error_during_execution', { terminal_reason: 'prompt_too_long' })]);
        expect((await tooLong.session.prompt('x').result).error?.code).toBe('context_exceeded');

        const cancelled = await run(async function* (_u, _t, ctx) {
            yield messageStart();
            yield* textBlocks('working');
            await ctx.onInterrupt;
            yield RESULT_ERROR('error_during_execution');
        });
        const turn = cancelled.session.prompt('x');
        for await (const e of turn) if (e.type === 'part-delta') await cancelled.session.cancel();
        expect((await turn.result).stopReason).toBe('cancelled');
        expect(cancelled.fake.interrupts).toBe(1);

        const rateLimited = await run(() => [m({ type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'text', text: 'slow' }] }, parent_tool_use_id: null, error: 'rate_limit' }), RESULT()]);
        const r = await drain(rateLimited.session.prompt('x'));
        expect(r.events.find((e) => e.type === 'error')).toMatchObject({ code: 'rate_limited', recoverable: true });
        expect(textOf(r.events)).toBe('slow'); // an un-streamed assistant message still yields its parts
        expect(r.result.stopReason).toBe('end_turn');

        const auth = await run(() => [m({ type: 'auth_status', ...base, isAuthenticating: false, output: [], error: 'not logged in' }), m({ type: 'assistant', ...base, message: { role: 'assistant', content: [] }, parent_tool_use_id: null, error: 'authentication_failed' }), RESULT_ERROR('error_during_execution')]);
        const a = await drain(auth.session.prompt('x'));
        expect(a.events.filter((e) => e.type === 'error').map((e) => (e as Extract<AgentEvent, { type: 'error' }>).code)).toEqual(['auth_required', 'auth_required', 'provider_error']);

        const exited = await run(() => [], { });
        const fakeExit = fakeQuery(() => [], { exitAfterTurns: 0 });
        const exitAgent = claudeCode({ query: fakeExit.query, listen: fakeListen });
        const exitSession = await exitAgent.session({ cwd, interactive: false });
        const x = await drain(exitSession.prompt('x'));
        expect(x.result).toMatchObject({ stopReason: 'error', error: { code: 'process_exited' } });
        void exited;
    });

    it('structured output rides on the query; a different schema restarts it on the same session', async () => {
        let prompts = 0; // across queries: a restart starts a fresh turn count
        const fake = fakeQuery(() => [messageStart(), ...textBlocks('{"ok":true}'), ...messageStop(), RESULT({ structured_output: prompts++ === 0 ? { ok: true } : { n: 1 } })]);
        const agent = claudeCode({ query: fake.query, listen: fakeListen });
        const session = await agent.session({ cwd, interactive: false });
        const okSchema: JsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
        const r1 = await session.prompt('x', { output: { schema: okSchema } }).result;
        expect(r1.output).toEqual({ ok: true });
        expect(fake.calls[0]!.outputFormat).toEqual({ type: 'json_schema', schema: okSchema });
        const r2 = await session.prompt('y', { output: { schema: { type: 'object', properties: { n: { type: 'number' } } } } }).result;
        expect(r2.output).toEqual({ n: 1 });
        expect(fake.calls).toHaveLength(2);
        expect(fake.calls[1]).toMatchObject({ resume: SESSION });
        expect(fake.closes).toBe(1);
        // Same schema again: no restart.
        await session.prompt('z', { output: { schema: { type: 'object', properties: { n: { type: 'number' } } } } }).result;
        expect(fake.calls).toHaveLength(2);
    });

    it('resume and fork go through the SDK options; configure() sets the model; listSessions maps summaries', async () => {
        const fake = fakeQuery(() => [messageStart(), ...textBlocks('hi'), ...messageStop(), RESULT()]);
        const agent = claudeCode({ query: fake.query, listen: fakeListen, listSessions: async () => [{ sessionId: 's9', summary: 'Fix the tests', lastModified: 123, cwd } as never] });
        const s1 = await agent.session({ cwd, interactive: false });
        await s1.prompt('a').result;
        const ref = s1.ref;
        await s1.close();
        const s2 = await agent.session({ cwd, interactive: false, resume: ref });
        expect(s2.id).toBe(SESSION);
        const { events } = await drain(s2.prompt('b'));
        expect(fake.calls[1]).toMatchObject({ resume: SESSION });
        expect(fake.calls[1]!.forkSession).toBeUndefined();
        expect(events[0]!.epoch).toBe(2);
        await s2.configure!({ model: 'claude-sonnet-5' });
        expect(fake.models).toEqual(['claude-sonnet-5']);
        const s3 = await agent.session({ cwd, interactive: false, resume: ref, fork: true });
        await s3.prompt('c').result;
        expect(fake.calls[2]).toMatchObject({ resume: SESSION, forkSession: true });
        expect(await agent.listSessions()).toEqual([{ ref: { agent: 'claude-code', v: 1, id: 's9', data: { cwd } }, title: 'Fix the tests', updatedAt: 123 }]);
        await expect(agent.session({ cwd, resume: { agent: 'other', v: 1, id: 'x' } })).rejects.toThrow(/belongs to agent/);
        await expect(agent.session({} as never)).rejects.toThrow(/cwd/);
        // bypassPermissions without the explicit opt-in is refused when the query would start: the turn fails.
        const bypass = await claudeCode({ query: fake.query, permissionMode: 'bypassPermissions' }).session({ cwd });
        expect(await bypass.prompt('x').result).toMatchObject({ stopReason: 'error', error: { code: 'protocol_error', message: expect.stringContaining('allowDangerouslySkipPermissions') } });
    });

    it('request helpers', () => {
        expect(splitToolName('mcp__sigx-tools__echo', 'sigx-tools')).toEqual({ name: 'echo', source: 'client' });
        expect(splitToolName('mcp__other__x', 'sigx-tools')).toEqual({ name: 'x', source: 'mcp' });
        expect(splitToolName('Read', 'sigx-tools')).toEqual({ name: 'Read', source: 'native' });
        expect(primaryArg({ file_path: '/a', command: 'ls' })).toBe('/a');
        expect(primaryArg({ command: 'ls' })).toBe('ls');
        expect(primaryArg('x')).toBe('');
        expect(toUserMessage([{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: 'AAA=' }])).toEqual({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } }] },
            parent_tool_use_id: null
        });
        expect(() => toUserMessage([{ type: 'file', mediaType: 'application/pdf', data: 'x' }])).toThrow(/not supported/);
    });
});

// ── conformance over the fake ───────────────────────────────────────────────

function scriptFor(scenario: ConformanceScenario): TurnScript {
    switch (scenario.name) {
        case 'tool-permission':
        case 'headless-deny':
            return async function* (_u, _t, ctx) {
                yield messageStart();
                yield* toolUseBlocks('toolu_g', 'mcp__sigx-tools__guarded', {});
                yield* messageStop();
                const r = await ctx.ask('mcp__sigx-tools__guarded', {});
                yield toolResult('toolu_g', r.behavior === 'allow' ? '{"ok":true}' : (r.message ?? 'denied'), r.behavior === 'deny');
                yield messageStart();
                yield* textBlocks('Done.');
                yield* messageStop();
                yield RESULT();
            };
        case 'tool-error':
            return async function* (_u, _t, ctx) {
                yield messageStart();
                yield* toolUseBlocks('toolu_f', 'mcp__sigx-tools__failing', {});
                yield* messageStop();
                await ctx.ask('mcp__sigx-tools__failing', {});
                yield toolResult('toolu_f', 'the tool failed on purpose', true);
                yield messageStart();
                yield* textBlocks('It failed.');
                yield* messageStop();
                yield RESULT();
            };
        case 'slow-tool':
            return async function* (_u, _t, ctx) {
                yield messageStart();
                yield* toolUseBlocks('toolu_s', 'mcp__sigx-tools__slow', {});
                yield* messageStop();
                await ctx.ask('mcp__sigx-tools__slow', {});
                yield progress('toolu_s', 'mcp__sigx-tools__slow');
                await ctx.onInterrupt;
                yield RESULT_ERROR('error_during_execution');
            };
        case 'model-error':
            return () => [m({ type: 'assistant', ...base, message: { role: 'assistant', content: [] }, parent_tool_use_id: null, error: 'server_error' }), RESULT_ERROR('error_during_execution')];
        case 'structured-output':
            return () => [messageStart(), ...textBlocks('{"ok":true}'), ...messageStop(), RESULT({ structured_output: { ok: true } })];
        default:
            return () => [messageStart(), ...textBlocks('Hello!'), ...messageStop(), RESULT()];
    }
}

describe('agentConformance: claudeCode(fake query)', () => {
    const cases = agentConformance((s) => claudeCode({ query: fakeQuery(scriptFor(s)).query, listen: fakeListen }), {
        capabilities: CLAUDE_CODE_CAPABILITIES,
        sessionOptions: { cwd },
        skip: (s) => (s.name === 'input-request' || s.name === 'support-agent' ? 'the Claude Agent SDK has no input request the adapter could surface (canUseTool is the only question it asks)' : undefined)
    });
    it('skips only what the harness cannot express (the permission scenarios need every-call; Claude Code is harness-filtered)', () => {
        expect(cases.filter((c) => c.skip).map((c) => c.name)).toEqual(['conformance: tool-permission', 'conformance: headless-deny', 'conformance: input-request', 'conformance: support-agent']);
    });
    for (const c of cases) it.skipIf(!!c.skip)(c.name, c.run, 15_000);
});

// ── live smoke ──────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SIGX_LIVE_CLAUDE_CODE)('@sigx/ai-agent-claude-code (live)', () => {
    it('runs one short turn against the real CLI and leaves no process behind', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'sigx-cc-'));
        const pids: number[] = [];
        // Our own spawner, wrapped only to remember the pids we started.
        const agent = claudeCode({
            spawn: (o) => {
                const p = spawnForSdk(o);
                const pid = (p as { pid?: number }).pid;
                if (pid) pids.push(pid);
                return p;
            }
        });
        try {
            const session = await agent.session({ cwd: dir, interactive: false, policy: allowReadOnly, maxTurns: 2 });
            const { events, result } = await drain(session.prompt('Reply with the single word: pong'));
            expect(textOf(events).toLowerCase()).toContain('pong');
            expect(result.stopReason).toBe('end_turn');
            expect(events.find((e) => e.type === 'config')).toBeDefined();
            expect(session.ref).toMatchObject({ agent: 'claude-code', v: 1, id: expect.stringMatching(/^[0-9a-f-]{36}$/), data: { cwd: dir } });
            expect(result.usage?.outputTokens).toBeGreaterThan(0);
        } finally {
            await agent.dispose();
            rmSync(dir, { recursive: true, force: true });
        }
        expect(pids.length).toBeGreaterThan(0);
        // The processes we spawned are gone (other claude.exe processes on the machine are not ours).
        for (const pid of pids) {
            if (process.platform === 'win32') {
                const list = await new Promise<string>((resolve) => execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], (_e, out) => resolve(String(out))));
                expect(list).not.toMatch(new RegExp(`\\b${pid}\\b`));
            } else {
                expect(() => process.kill(pid, 0)).toThrow();
            }
        }
    }, 120_000);
});
