import { describe, it, expect } from 'vitest';
import { defineTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { mockModel, type MockReply } from '@sigx/ai/testing';
import { agentTool, modelAgent, allowAll, agentTree, createReducer, createTranscript, reduceAgentEvent, spawnedAgent, type AgentEvent, type AgentSession } from '@sigx/ai-agent';
import { checkEventInvariants, checkReplayEquality, mockAgent } from '@sigx/ai-agent/testing';
import { collect } from '../helpers';

/** Run one host turn on `modelAgent` over `tools`, collecting the whole session log; `on` reacts to events as they stream. */
async function hostTurn(tools: Parameters<typeof modelAgent>[0]['tools'], rounds: (round: number) => MockReply, on?: (e: AgentEvent, session: AgentSession) => Promise<void> | void) {
    const model = mockModel({ respond: (_r, round) => rounds(round) });
    const session = await modelAgent({ model, tools }).session({ policy: allowAll });
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

const toolCalls = (events: readonly AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call');

function schema<T>(check: (v: unknown) => v is T, json: JsonSchema): StandardSchemaV1<T, T> {
    return { '~standard': { version: 1, vendor: 'test', validate: (v) => (check(v) ? { value: v } : { issues: [{ message: 'invalid' }] }), jsonSchema: { input: () => json, output: () => json } } };
}
const question = schema((v): v is { question: string } => typeof v === 'object' && v !== null && typeof (v as { question?: unknown }).question === 'string', { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] });
const answer = schema((v): v is { answer: string } => typeof v === 'object' && v !== null && typeof (v as { answer?: unknown }).answer === 'string', { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] });

describe('agentTool', () => {
    it('is a defineTool tool that returns the delegate’s final text', async () => {
        const delegate = mockAgent({ script: [[{ text: 'The answer is 42.' }]] });
        const tool = agentTool(delegate, { name: 'ask', description: 'Ask the researcher.', input: question, prompt: (i) => i.question });
        expect(tool.spec).toMatchObject({ name: 'ask', description: 'Ask the researcher.' });
        expect(await tool.run({ question: 'life?' }, { signal: new AbortController().signal, toolCallId: 'c1' })).toBe('The answer is 42.');
        expect(delegate.sessions).toHaveLength(1);
    });

    it('returns validated structured output when a schema is given', async () => {
        const delegate = mockAgent({ script: [[{ text: 'irrelevant' }, { output: { answer: '42' } }]] });
        const tool = agentTool(delegate, { name: 'ask', description: 'x', input: question, output: answer, prompt: (i) => i.question });
        const result = await tool.run({ question: 'q' }, { signal: new AbortController().signal, toolCallId: 'c1' });
        expect(result).toEqual({ answer: '42' });
        // Without structuredOutput the final text is parsed instead.
        const textOnly = mockAgent({ capabilities: { structuredOutput: false }, script: [[{ text: '{"answer":"43"}' }]] });
        expect(await agentTool(textOnly, { name: 'ask', description: 'x', input: question, output: answer, prompt: (i) => i.question }).run({ question: 'q' }, { signal: new AbortController().signal, toolCallId: 'c2' })).toEqual({ answer: '43' });
        // A bad output is a validation error the host engine turns into an error result.
        const bad = mockAgent({ script: [[{ output: { nope: 1 } }]] });
        await expect(agentTool(bad, { name: 'ask', description: 'x', input: question, output: answer, prompt: (i) => i.question }).run({ question: 'q' }, { signal: new AbortController().signal, toolCallId: 'c3' })).rejects.toThrow(/does not match the schema/);
    });

    it('a failing or cancelled delegate throws', async () => {
        const failing = mockAgent({ script: [[{ error: { code: 'rate_limited', message: 'slow down' } }]] });
        await expect(agentTool(failing, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question }).run({ question: 'q' }, { signal: new AbortController().signal, toolCallId: 'c1' })).rejects.toThrow('slow down');
        const slow = mockAgent({ script: [[{ tool: { name: 'slow', delayMs: 5000 } }]] });
        const ctrl = new AbortController();
        const p = agentTool(slow, { name: 'ask', description: 'x', input: question, sessionOptions: { policy: allowAll }, prompt: (i) => i.question }).run({ question: 'q' }, { signal: ctrl.signal, toolCallId: 'c1' });
        setTimeout(() => ctrl.abort(), 10);
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('nested inside a modelAgent turn: the delegate’s events arrive with parentCallId', async () => {
        const delegate = mockAgent({ script: [[{ text: 'found it', actor: 'researcher' }, { tool: { name: 'search', input: { q: 'x' }, output: [1, 2] } }, { ext: { ns: 'coding', name: 'files-changed', data: { paths: ['a'] } } }]] });
        const ask = agentTool(delegate, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question, sessionOptions: { policy: allowAll } });
        const model = mockModel({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Summary.' }) });
        const host = modelAgent({ model, tools: [ask] });
        const session = await host.session({ policy: allowAll });
        const events = await collect(session.prompt('go'));
        const nested = events.filter((e) => e.parentCallId === 'host1');
        expect(nested.map((e) => e.type)).toEqual(['agent-start', 'agent-update', 'part-start', 'part-delta', 'part-delta', 'part-end', 'tool-call', 'tool-update', 'request-resolved', 'tool-update', 'tool-update', 'ext', 'agent-update']);
        expect(nested.every((e) => e.turnId === events[0]!.turnId)).toBe(true);
        expect(nested.find((e) => e.type === 'part-start')).toMatchObject({ actor: 'researcher' });
        // The host's transcript keeps the nested message under the call.
        const t = createTranscript(session.id);
        for (const e of events) reduceAgentEvent(t, e);
        expect(t.messages.map((m) => [m.role, m.parentCallId])).toEqual([
            ['user', undefined],
            ['assistant', undefined],
            ['assistant', 'host1']
        ]);
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'host1' && e.status === 'completed')).toMatchObject({ output: 'found it' });
        expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', content: [{ toolCallId: 'host1', output: 'found it' }] });
        const onEvent: AgentEvent[] = [];
        const observed = agentTool(mockAgent({ script: [[{ text: 'x' }]] }), { name: 'o', description: 'x', input: question, prompt: (i) => i.question, onEvent: (e) => onEvent.push(e) });
        await observed.run({ question: 'q' }, { signal: new AbortController().signal, toolCallId: 'c9' });
        expect(onEvent.map((e) => e.type)).toContain('turn-end');
    });

    it('child usage is attributed to the delegate, not summed into the host session totals', async () => {
        const delegate = mockAgent({ script: [[{ text: 'x' }, { usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.5 }]] });
        const ask = agentTool(delegate, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question });
        const { t, log } = await hostTurn([ask], (round) => ({ ...(round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Summary.' }), usage: { inputTokens: 10, outputTokens: 5 } }));
        expect(t.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
        expect(log.filter((e) => e.type === 'usage' && e.parentCallId !== undefined)).toEqual([]);
        const agent = spawnedAgent(t, 'host1')!;
        expect(agent).toMatchObject({ status: 'completed', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.5, depth: 0 });
    });

    it('the delegate is a sub-agent of the host: agent-start / agent-update frame its nested events', async () => {
        const delegate = mockAgent({ script: [[{ text: 'found it' }, { usage: { inputTokens: 7 } }]] });
        const ask = agentTool(delegate, { name: 'ask', description: 'x', title: 'Researcher', input: question, prompt: (i) => i.question });
        const { events, t, result } = await hostTurn([ask], (round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'life?' }, id: 'host1' }] } : { text: 'Summary.' }));
        expect(result.stopReason).toBe('end_turn');
        const agentId = delegate.sessions[0]!.id;
        const nested = events.filter((e) => e.parentCallId === 'host1');
        expect(nested.map((e) => e.type)).toEqual(['agent-start', 'agent-update', 'part-start', 'part-delta', 'part-delta', 'part-end', 'agent-update', 'agent-update']);
        expect(nested[0]).toMatchObject({ type: 'agent-start', agentId, callId: 'host1', kind: 'ask', title: 'Researcher', description: 'life?' });
        expect(nested[1]).toMatchObject({ type: 'agent-update', agentId, status: 'running' });
        expect(nested[6]).toMatchObject({ type: 'agent-update', agentId, status: 'running', usage: { inputTokens: 7 } });
        expect(nested[7]).toMatchObject({ type: 'agent-update', agentId, status: 'completed', usage: { inputTokens: 7 }, output: 'found it' });
        // The host settles its own call after the agent settled.
        const hostDone = events.find((e) => e.type === 'tool-update' && e.callId === 'host1' && e.status === 'completed')!;
        expect(hostDone.seq).toBeGreaterThan(nested[7]!.seq);
        expect(t.agents[agentId]).toMatchObject({ callId: 'host1', depth: 0, status: 'completed', kind: 'ask' });
        expect(t.messages.find((m) => m.parentCallId === 'host1')?.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'found it' });
        const tool = t.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.callId === 'host1');
        expect(tool).toMatchObject({ agentId });
    });

    it('a delegate whose output does not validate ends failed; an erroring one too', async () => {
        const bad = mockAgent({ script: [[{ output: { nope: 1 } }]] });
        const ask = agentTool(bad, { name: 'ask', description: 'x', input: question, output: answer, prompt: (i) => i.question });
        const { events, result } = await hostTurn([ask], (round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Summary.' }));
        expect(result.stopReason).toBe('end_turn');
        const terminal = events.filter((e) => e.type === 'agent-update' && e.status !== 'running');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({ status: 'failed', error: { code: 'provider_error', message: expect.stringContaining('does not match the schema') } });
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'host1' && e.status === 'failed')).toBeDefined();

        const failing = mockAgent({ script: [[{ error: { code: 'rate_limited', message: 'slow down' } }]] });
        const ask2 = agentTool(failing, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question });
        const r2 = await hostTurn([ask2], (round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Summary.' }));
        expect(r2.events.filter((e) => e.type === 'agent-update' && e.status !== 'running')).toEqual([expect.objectContaining({ status: 'failed', error: { code: 'rate_limited', message: 'slow down' } })]);
    });

    it('a request raised inside the delegate is answered through the host session', async () => {
        const delegate = mockAgent({ script: [[{ tool: { name: 'guarded', source: 'client', output: { ok: true } } }, { text: 'done' }]] });
        const ask = agentTool(delegate, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question, sessionOptions: { interactive: true } });
        const { events, result, t } = await hostTurn(
            [ask],
            (round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Summary.' }),
            async (e, session) => {
                if (e.type === 'request') {
                    expect(e).toMatchObject({ parentCallId: 'host1', kind: 'permission', toolName: 'guarded' });
                    await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
                }
            }
        );
        expect(result.stopReason).toBe('end_turn');
        expect(events.filter((e) => e.type === 'request')).toHaveLength(1);
        expect(events.find((e) => e.type === 'request-resolved' && e.parentCallId === 'host1')).toMatchObject({ by: 'client', outcome: 'allow' });
        expect(events.find((e) => e.type === 'tool-update' && e.parentCallId === 'host1' && e.status === 'completed')).toMatchObject({ output: { ok: true } });
        expect(spawnedAgent(t, 'host1')).toMatchObject({ status: 'completed', output: 'done' });
    });

    it('cancel({ agentId }) cancels the delegate while the host turn goes on', async () => {
        const slow = mockAgent({ script: [[{ tool: { name: 'slow', delayMs: 5000 } }]] });
        const ask = agentTool(slow, { name: 'ask', description: 'x', input: question, sessionOptions: { policy: allowAll }, prompt: (i) => i.question });
        let agentId: string | undefined;
        const { events, result, t } = await hostTurn(
            [ask],
            (round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Moving on.' }),
            async (e, session) => {
                if (e.type === 'agent-start') agentId = e.agentId;
                if (e.type === 'tool-update' && e.parentCallId === 'host1' && e.status === 'in_progress') {
                    await session.cancel({ agentId: 'no-such-agent' }); // a target that does not run is a no-op
                    await session.cancel({ agentId: agentId! });
                }
            }
        );
        expect(result.stopReason).toBe('end_turn');
        expect(events.filter((e) => e.type === 'agent-update' && e.status !== 'running')).toEqual([expect.objectContaining({ status: 'cancelled' })]);
        expect(events.find((e) => e.type === 'tool-update' && e.parentCallId === 'host1' && e.status === 'cancelled')).toBeDefined();
        expect(events.find((e) => e.type === 'tool-update' && e.callId === 'host1' && e.status === 'failed')).toMatchObject({ error: expect.stringContaining('cancelled') });
        expect(spawnedAgent(t, 'host1')).toMatchObject({ status: 'cancelled' });
    });

    it('a delegate that delegates: the grandchild sits one level deeper in the tree', async () => {
        const leafAgent = mockAgent({ script: [[{ text: 'leaf says hi' }]] });
        const leaf = agentTool(leafAgent, { name: 'leaf', description: 'x', input: question, prompt: (i) => i.question });
        const mid = modelAgent({ id: 'mid', model: mockModel({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'leaf', input: { question: 'q' }, id: 'mid1' }] } : { text: 'mid done' }) }), tools: [leaf] });
        const ask = agentTool(mid, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question, sessionOptions: { policy: allowAll } });
        const { t, result } = await hostTurn([ask], (round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Summary.' }));
        expect(result.stopReason).toBe('end_turn');
        const tree = agentTree(t);
        expect(tree).toHaveLength(1);
        expect(tree[0]!.agent).toMatchObject({ kind: 'ask', callId: 'host1', depth: 0, status: 'completed' });
        expect(tree[0]!.children).toHaveLength(1);
        // The ids of the middle session travel up prefixed with it — one prefix per level.
        const midId = tree[0]!.agent.agentId;
        const midCall = `${midId}/mid1`;
        expect(tree[0]!.children[0]!.agent).toMatchObject({ kind: 'leaf', callId: midCall, depth: 1, status: 'completed', output: 'leaf says hi', parentAgentId: midId });
        expect(tree[0]!.children[0]!.agent.agentId.startsWith(`${midId}/`)).toBe(true);
        expect(t.messages.find((m) => m.parentCallId === midCall)?.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'leaf says hi' });
    });

    it('a delegate that reuses the host’s call ids still nests cleanly', async () => {
        // Both models number their generated calls from `call_1`, so the
        // delegate's `look` call would be the host's `ask` call verbatim.
        const look = defineTool({ name: 'look', description: 'x', input: question, execute: () => 'looked' });
        const delegate = modelAgent({ id: 'delegate', model: mockModel({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'look', input: { question: 'q' } }] } : { text: 'found it' }) }), tools: [look] });
        const ask = agentTool(delegate, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question, sessionOptions: { policy: allowAll } });
        const { events, result, t } = await hostTurn([ask], (round) => (round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' } }] } : { text: 'Summary.' }));
        expect(result.stopReason).toBe('end_turn');
        const hostCall = toolCalls(events).find((e) => e.name === 'ask')!;
        const nestedCall = toolCalls(events).find((e) => e.name === 'look')!;
        // The raw ids collide; the forwarded one is namespaced, so they don't.
        expect(hostCall.callId).toBe('call_1');
        expect(nestedCall.callId).not.toBe(hostCall.callId);
        expect(nestedCall.parentCallId).toBe(hostCall.callId);
        // The host's own call settles — before the fix the delegate's
        // `tool-update`s landed on it and it never did.
        expect(events.find((e) => e.type === 'tool-update' && e.callId === hostCall.callId && e.status === 'completed')).toMatchObject({ output: 'found it' });
        const nestedUpdates = events.filter((e) => e.type === 'tool-update' && e.callId === nestedCall.callId);
        expect(nestedUpdates.at(-1)).toMatchObject({ status: 'completed', output: 'looked', parentCallId: hostCall.callId });
        // The transcript keeps them apart: one part per call, each under its own message.
        const parts = t.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool');
        expect(parts.map((p) => [p.name, p.callId, p.status])).toEqual([
            ['ask', hostCall.callId, 'completed'],
            ['look', nestedCall.callId, 'completed']
        ]);
    });

    it('two delegates in one turn keep their ids apart', async () => {
        const look = defineTool({ name: 'look', description: 'x', input: question, execute: () => 'looked' });
        const delegate = (name: string) => modelAgent({ id: name, model: mockModel({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'look', input: { question: 'q' } }] } : { text: `${name} done` }) }), tools: [look] });
        const tools = ['one', 'two'].map((name) => agentTool(delegate(name), { name, description: 'x', input: question, prompt: (i) => i.question, sessionOptions: { policy: allowAll } }));
        const { events, result } = await hostTurn(tools, (round) =>
            round === 0
                ? {
                      toolCalls: [
                          { name: 'one', input: { question: 'q' } },
                          { name: 'two', input: { question: 'q' } }
                      ]
                  }
                : { text: 'Summary.' }
        );
        expect(result.stopReason).toBe('end_turn');
        // Four calls, four ids: the host's two plus one from each delegate,
        // both of which minted `call_1` for themselves.
        const calls = toolCalls(events);
        expect(calls).toHaveLength(4);
        expect(new Set(calls.map((e) => e.callId)).size).toBe(4);
        expect(calls.filter((e) => e.name === 'look').map((e) => e.parentCallId)).toEqual(calls.filter((e) => e.name !== 'look').map((e) => e.callId));
        for (const host of calls.filter((e) => e.name !== 'look')) expect(events.find((e) => e.type === 'tool-update' && e.callId === host.callId && e.status === 'completed')).toMatchObject({ output: `${host.name} done` });
    });

    it('a plain defineTool still works as a host tool alongside agentTool', () => {
        const plain = defineTool({ name: 'plain', description: 'x', input: question, execute: (i) => i.question });
        expect(plain.spec.name).toBe('plain');
    });
});
