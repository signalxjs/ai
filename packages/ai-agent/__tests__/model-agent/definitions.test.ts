import { describe, it, expect } from 'vitest';
import { defineTool, type JsonSchema, type ModelRequest, type StandardSchemaV1 } from '@sigx/ai';
import { mockModel, type MockReply } from '@sigx/ai/testing';
import { modelAgent, MODEL_AGENT_CAPABILITIES, allowAll, allowReadOnly, agentTree, createReducer, createTranscript, reduceAgentEvent, spawnedAgent, AgentError, type AgentEvent, type AgentSession, type SessionOptions } from '@sigx/ai-agent';
import { checkEventInvariants, checkReplayEquality } from '@sigx/ai-agent/testing';
import { collect } from '../helpers';

function schema<T>(check: (v: unknown) => v is T, json: JsonSchema): StandardSchemaV1<T, T> {
    return { '~standard': { version: 1, vendor: 'test', validate: (v) => (check(v) ? { value: v } : { issues: [{ message: 'invalid' }] }), jsonSchema: { input: () => json, output: () => json } } };
}
const anyObject = schema((v): v is Record<string, unknown> => typeof v === 'object' && v !== null, { type: 'object', additionalProperties: true });

const echo = defineTool({ name: 'echo', description: 'Echoes its input.', input: anyObject, execute: (input) => ({ echoed: input }) });
const lookup = defineTool({ name: 'lookup', description: 'Read-only.', input: anyObject, annotations: { readOnly: true }, execute: () => 'fine' });
const slow = defineTool({ name: 'slow', description: 'Waits for abort.', input: anyObject, execute: (_i, ctx) => new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });

const REVIEW_PROMPT = 'You review.';
/** The host and its defined sub-agents share one mock model; the system prompt tells them apart. */
const isDelegate = (req: ModelRequest) => req.system === REVIEW_PROMPT;
const afterTools = (req: ModelRequest) => req.messages.some((m) => m.role === 'tool');

/** One host turn with agent definitions; `on` reacts to streamed events. */
async function run(reply: (req: ModelRequest) => MockReply, sessionOptions: SessionOptions, on?: (e: AgentEvent, session: AgentSession) => Promise<void> | void) {
    const model = mockModel({ respond: (req) => reply(req) });
    const agent = modelAgent({ model, tools: [echo, lookup, slow] });
    const session = await agent.session(sessionOptions);
    // From the start, not live: a session announces its `config` before
    // anyone can subscribe, and `fromStart: true` below means the whole log.
    const all = collect(session.subscribe({ epoch: 0, seq: 0 }));
    const turn = session.prompt('go');
    const events: AgentEvent[] = [];
    for await (const e of turn) {
        events.push(e);
        await on?.(e, session);
    }
    const result = await turn.result;
    await session.close();
    const log = await all;
    checkEventInvariants(log, { fromStart: true });
    checkReplayEquality(log, createReducer());
    const t = createTranscript(session.id);
    for (const e of log) reduceAgentEvent(t, e);
    return { model, session, events, result, log, t };
}

describe('modelAgent agent definitions (defineAgents)', () => {
    it('declares defineAgents', () => {
        expect(MODEL_AGENT_CAPABILITIES.defineAgents).toBe(true);
    });

    it('a definition is a tool the model can call; the delegate is a sub-agent named after it, sees only its tools, and its text is the tool result', async () => {
        const { model, events, result, t } = await run(
            (req) => (isDelegate(req) ? { text: 'looks fine' } : afterTools(req) ? { text: 'Reviewed.' } : { toolCalls: [{ name: 'reviewer', input: { task: 'check it' }, id: 'r1' }] }),
            { policy: allowAll, agents: { reviewer: { description: 'Reviews a change.', prompt: REVIEW_PROMPT, tools: ['lookup'], model: 'ignored-alias' } } }
        );
        expect(result.stopReason).toBe('end_turn');
        // The host model sees the definition as a tool next to the real ones.
        expect(model.requests[0]!.tools!.map((tl) => tl.name)).toEqual(['echo', 'lookup', 'slow', 'reviewer']);
        expect(model.requests[0]!.tools!.find((tl) => tl.name === 'reviewer')).toMatchObject({ description: 'Reviews a change.', inputSchema: expect.objectContaining({ required: ['task'] }) });
        // The delegate ran with the definition's prompt and only the tools it names.
        const delegateRequest = model.requests.find(isDelegate)!;
        expect(delegateRequest.tools!.map((tl) => tl.name)).toEqual(['lookup']);
        expect(delegateRequest.messages).toEqual([{ role: 'user', content: 'check it' }]);
        // Framed as a sub-agent of the spawning call.
        expect(events.find((e) => e.type === 'agent-start')).toMatchObject({ callId: 'r1', kind: 'reviewer', title: 'reviewer', description: 'check it', parentCallId: 'r1' });
        expect(events.filter((e) => e.type === 'agent-update' && e.status !== 'running')).toEqual([expect.objectContaining({ status: 'completed', output: 'looks fine' })]);
        expect(events.find((e) => e.type === 'part-delta' && e.parentCallId === 'r1')).toBeDefined();
        expect(spawnedAgent(t, 'r1')).toMatchObject({ kind: 'reviewer', status: 'completed', depth: 0 });
        expect(agentTree(t)).toHaveLength(1);
        // The host model got the delegate's words as the tool result.
        const toolMsg = model.requests.find((r) => !isDelegate(r) && afterTools(r))!.messages.find((m) => m.role === 'tool')!;
        expect(toolMsg.content).toEqual([{ type: 'tool-result', toolCallId: 'r1', toolName: 'reviewer', output: 'looks fine' }]);
    });

    it('arguments beyond { task } fail the call before any sub-agent starts — the validator matches the JSON Schema', async () => {
        const { events, result } = await run(
            (req) => (isDelegate(req) ? { text: 'never' } : afterTools(req) ? { text: 'Done.' } : { toolCalls: [{ name: 'reviewer', input: { task: 'x', extra: true }, id: 'r1' }] }),
            { policy: allowAll, agents: { reviewer: { description: 'x', prompt: REVIEW_PROMPT } } }
        );
        expect(result.stopReason).toBe('end_turn');
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'r1' && e.status === 'failed')).toMatchObject({ error: expect.stringContaining('Invalid arguments') });
        expect(events.find((e) => e.type === 'agent-start')).toBeUndefined();
    });

    it('a definition without a prompt runs with no system prompt — never the host’s', async () => {
        const model = mockModel({ respond: (req) => (req.system === undefined ? { text: 'bare' } : afterTools(req) ? { text: 'Done.' } : { toolCalls: [{ name: 'helper', input: { task: 't' }, id: 'h1' }] }) });
        const session = await modelAgent({ model, system: 'You are the host.' }).session({ policy: allowAll, agents: { helper: { description: 'x' } } });
        const { stopReason } = await session.prompt('go').result;
        expect(stopReason).toBe('end_turn');
        expect(model.requests.map((r) => r.system)).toEqual(['You are the host.', undefined, 'You are the host.']);
        await session.close();
    });

    it('maxTurns bounds the delegate’s model rounds', async () => {
        const { model, events } = await run(
            (req) => (isDelegate(req) ? { toolCalls: [{ name: 'lookup', input: {} }] } : afterTools(req) ? { text: 'Done.' } : { toolCalls: [{ name: 'reviewer', input: { task: 'loop' }, id: 'r1' }] }),
            { policy: allowAll, agents: { reviewer: { description: 'x', prompt: REVIEW_PROMPT, maxTurns: 1 } } }
        );
        expect(model.requests.filter(isDelegate)).toHaveLength(1);
        expect(events.filter((e) => e.type === 'agent-update' && e.status !== 'running')).toHaveLength(1);
    });

    it('a permission request raised inside the delegate is answered through the host session', async () => {
        const seen: AgentEvent[] = [];
        // The delegate's own ids reach the host namespaced by its session id.
        let delegateId: string | undefined;
        const { events, result, t } = await run(
            (req) => (isDelegate(req) ? (afterTools(req) ? { text: 'echoed' } : { toolCalls: [{ name: 'echo', input: { a: 1 }, id: 'd1' }] }) : afterTools(req) ? { text: 'Reviewed.' } : { toolCalls: [{ name: 'reviewer', input: { task: 'use echo' }, id: 'r1' }] }),
            { policy: allowReadOnly, agents: { reviewer: { description: 'x', prompt: REVIEW_PROMPT } } },
            async (e, session) => {
                if (e.type === 'agent-start') delegateId = e.agentId;
                // The host asks about spawning the reviewer (not read-only) — then the reviewer asks about echo.
                if (e.type === 'request') {
                    seen.push(e);
                    if (e.toolName === 'echo') expect(e).toMatchObject({ parentCallId: 'r1', kind: 'permission', callId: `${delegateId}/d1` });
                    else expect(e).toMatchObject({ kind: 'permission', toolName: 'reviewer', callId: 'r1' });
                    expect(e.parentCallId === undefined).toBe(e.toolName === 'reviewer');
                    await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
                }
            }
        );
        expect(result.stopReason).toBe('end_turn');
        expect(seen.map((e) => (e as Extract<AgentEvent, { type: 'request' }>).toolName)).toEqual(['reviewer', 'echo']);
        expect(events.find((e) => e.type === 'request-resolved' && e.parentCallId === 'r1')).toMatchObject({ by: 'client', outcome: 'allow' });
        expect(events.find((e) => e.type === 'tool-update' && e.callId === `${delegateId}/d1` && e.status === 'completed')).toBeDefined();
        expect(spawnedAgent(t, 'r1')).toMatchObject({ status: 'completed', output: 'echoed' });
    });

    it('cancel({ agentId }) cancels the delegate while the host turn goes on', async () => {
        let agentId: string | undefined;
        const { events, result, t } = await run(
            (req) => (isDelegate(req) ? { toolCalls: [{ name: 'slow', input: {}, id: 'd1' }] } : afterTools(req) ? { text: 'Moving on.' } : { toolCalls: [{ name: 'reviewer', input: { task: 'wait' }, id: 'r1' }] }),
            { policy: allowAll, agents: { reviewer: { description: 'x', prompt: REVIEW_PROMPT } } },
            async (e, session) => {
                if (e.type === 'agent-start') agentId = e.agentId;
                // The delegate's `d1` arrives namespaced; what identifies it here is the call it sits under.
                if (e.type === 'tool-update' && e.parentCallId === 'r1' && e.status === 'in_progress') await session.cancel({ agentId: agentId! });
            }
        );
        expect(result.stopReason).toBe('end_turn');
        expect(events.filter((e) => e.type === 'agent-update' && e.status !== 'running')).toEqual([expect.objectContaining({ status: 'cancelled' })]);
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'r1' && e.status === 'failed')).toMatchObject({ error: expect.stringContaining('cancelled') });
        expect(spawnedAgent(t, 'r1')).toMatchObject({ status: 'cancelled' });
    });

    it('rejects an invalid name, a name a tool already has, and an unknown tool in the definition', async () => {
        const agent = modelAgent({ model: mockModel(), tools: [echo] });
        const failing = (agents: Record<string, { description: string; tools?: string[] }>) => agent.session({ agents }).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(await failing({ 'bad name': { description: 'x' } })).toMatchObject({ name: 'AgentError', code: 'protocol_error', message: expect.stringContaining('bad name') });
        expect(await failing({ echo: { description: 'x' } })).toMatchObject({ code: 'protocol_error', message: expect.stringContaining('echo') });
        expect(await failing({ reviewer: { description: 'x', tools: ['nope'] } })).toMatchObject({ code: 'protocol_error', message: expect.stringContaining('nope') });
        expect(await failing({ reviewer: { description: 'x', tools: ['echo', 'echo'] } })).toMatchObject({ code: 'protocol_error', message: expect.stringContaining('twice') });
        expect(await failing({ reviewer: { description: 'x' } })).toBeUndefined();
        expect(new AgentError('protocol_error', 'x')).toBeInstanceOf(Error);
        await agent.dispose();
    });
});

describe('modelAgent agent definitions: the model a delegate runs on', () => {
    /** One host turn that delegates once; the delegate's reply is the turn's text. */
    async function delegateOn(definitionModel: string | undefined) {
        const host = mockModel({ respond: (req) => (isDelegate(req) ? { text: 'host model' } : req.messages.some((m) => m.role === 'tool') ? { text: 'Done.' } : { toolCalls: [{ name: 'reviewer', input: { task: 'x' }, id: 'r1' }] }), modelId: 'host' });
        const other = mockModel({ script: [{ text: 'other model' }], modelId: 'other' });
        const agent = modelAgent({ model: host, models: [other] });
        const session = await agent.session({
            policy: allowAll,
            agents: { reviewer: { description: 'x', prompt: REVIEW_PROMPT, ...(definitionModel !== undefined ? { model: definitionModel } : {}) } }
        });
        const events = await collect(session.prompt('go'));
        await session.close();
        const parts = events.filter((e): e is Extract<AgentEvent, { type: 'part-delta' }> => e.type === 'part-delta' && e.parentCallId !== undefined);
        return parts.map((e) => e.delta).join('');
    }

    it('runs the delegate on the model the definition names, when the agent offers it', async () => {
        expect(await delegateOn('other')).toBe('other model');
    });

    it('keeps the session’s model when the definition names one the agent does not offer — a definition’s model is a harness alias, not an error', async () => {
        expect(await delegateOn('sonnet-ish')).toBe('host model');
    });

    it('keeps the session’s model when the definition names none', async () => {
        expect(await delegateOn(undefined)).toBe('host model');
    });
});
