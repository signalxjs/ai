import { describe, it, expect } from 'vitest';
import { defineTool, type StandardSchemaV1, type JsonSchema } from '@sigx/ai';
import { mockModel, type MockModelOptions } from '@sigx/ai/testing';
import { modelAgent, MODEL_AGENT_CAPABILITIES, allowAll, allowReadOnly, firstMatch, memoryTranscriptStore, createTranscript, reduceAgentEvent, toUIMessages, type AgentEvent } from '@sigx/ai-agent';
import { collect, drain, types, textOf } from '../helpers';

/** A dependency-free Standard Schema from a predicate + JSON Schema (as the core tests do). */
function schema<T>(check: (v: unknown) => v is T, json: JsonSchema): StandardSchemaV1<T, T> {
    return { '~standard': { version: 1, vendor: 'test', validate: (v) => (check(v) ? { value: v } : { issues: [{ message: 'invalid' }] }), jsonSchema: { input: () => json, output: () => json } } };
}
const anyObject = schema((v): v is Record<string, unknown> => typeof v === 'object' && v !== null, { type: 'object', additionalProperties: true });
const okSchema = schema((v): v is { ok: boolean } => typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean', { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });

const echo = defineTool({ name: 'echo', description: 'Echoes its input.', input: anyObject, execute: (input) => ({ echoed: input }) });
const readOnly = defineTool({ name: 'lookup', description: 'Read-only.', input: anyObject, annotations: { readOnly: true }, execute: () => 'fine' });
const failing = defineTool({
    name: 'failing',
    description: 'Throws.',
    input: anyObject,
    execute: () => {
        throw new Error('boom');
    }
});
const slow = defineTool({ name: 'slow', description: 'Waits for abort.', input: anyObject, execute: (_i, ctx) => new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });

const agentWith = (opts: MockModelOptions, extra: Partial<Parameters<typeof modelAgent>[0]> = {}) => {
    const model = mockModel(opts);
    return { model, agent: modelAgent({ model, tools: [echo, readOnly, failing, slow], ...extra }) };
};

describe('modelAgent', () => {
    it('declares its capabilities and streams a text turn from the engine', async () => {
        const { agent, model } = agentWith({ script: [{ reasoning: 'hm', text: 'Hello there', usage: { inputTokens: 1, outputTokens: 2 } }] }, { system: 'be brief' });
        expect(agent.id).toBe('sigx');
        expect(agent.capabilities).toEqual(MODEL_AGENT_CAPABILITIES);
        const session = await agent.session();
        const { events, result } = await drain(session.prompt('hi'));
        expect(types(events)).toEqual(['turn-start', 'user-message', 'part-start', 'part-delta', 'part-end', 'part-start', 'part-delta', 'part-delta', 'part-end', 'usage', 'turn-end']);
        expect(textOf(events)).toBe('hmHello there');
        expect(result).toEqual({ turnId: events[0]!.turnId, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } });
        expect(model.requests[0]!.system).toBe('be brief');
        expect(model.requests[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
        // The second turn sees the whole transcript.
        await session.prompt('again').result;
        expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        await agent.dispose();
    });

    it('U2 headless: a policy allows read-only tools, denies the rest, the turn continues', async () => {
        const { agent, model } = agentWith({
            respond: (_req, round) =>
                round === 0 ? { toolCalls: [{ name: 'lookup', input: { q: 1 }, id: 'c1' }, { name: 'echo', input: { x: 1 }, id: 'c2' }] } : { text: 'done' }
        });
        const session = await agent.session({ interactive: false, policy: allowReadOnly });
        const { events, result } = await drain(session.prompt('go'));
        expect(result.stopReason).toBe('end_turn');
        const updates = events.filter((e): e is Extract<AgentEvent, { type: 'tool-update' }> => e.type === 'tool-update');
        expect(updates.filter((u) => u.callId === 'c1').map((u) => u.status)).toEqual(['pending', 'in_progress', 'completed']);
        expect(updates.filter((u) => u.callId === 'c2').map((u) => u.status)).toEqual(['pending', 'denied']);
        expect(events.filter((e) => e.type === 'request')).toHaveLength(0);
        const resolved = events.filter((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved');
        expect(resolved.map((r) => [r.outcome, r.by, r.ruleId ?? r.reason])).toEqual([
            ['allow', 'policy', 'allowReadOnly'],
            ['deny', 'policy', 'non-interactive']
        ]);
        // The model saw the denial as an error result and the lookup's output.
        const toolMsg = model.requests[1]!.messages.find((m) => m.role === 'tool')!;
        expect(toolMsg.content).toEqual([
            { type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', output: 'fine' },
            { type: 'tool-result', toolCallId: 'c2', toolName: 'echo', output: expect.stringContaining('not interactive'), isError: true }
        ]);
        expect(events.find((e) => e.type === 'tool-call' && e.callId === 'c1')).toMatchObject({ annotations: { readOnly: true }, messageId: expect.stringMatching(/^a:/) });
    });

    it('interactive: asks the client, honours respond(), remembers session grants', async () => {
        const { agent } = agentWith({
            respond: (_req, round) => (round === 0 ? { toolCalls: [{ name: 'echo', input: { a: 1 }, id: 'c1' }] } : round === 1 ? { toolCalls: [{ name: 'echo', input: { a: 2 }, id: 'c2' }] } : { text: 'ok' })
        });
        const session = await agent.session();
        const turn = session.prompt('go');
        const seen: AgentEvent[] = [];
        for await (const e of turn) {
            seen.push(e);
            if (e.type === 'request') {
                expect(e).toMatchObject({ kind: 'permission', toolName: 'echo', callId: 'c1', permissionKey: 'tool:echo' });
                await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
            }
        }
        expect(seen.filter((e) => e.type === 'request')).toHaveLength(1);
        expect(seen.filter((e) => e.type === 'request-resolved').map((e) => (e as Extract<AgentEvent, { type: 'request-resolved' }>).by)).toEqual(['client', 'policy']);
        expect(seen.filter((e) => e.type === 'tool-update' && e.status === 'completed')).toHaveLength(2);
        expect((await turn.result).stopReason).toBe('end_turn');
    });

    it('invalid tool arguments fail before anyone is asked', async () => {
        const { agent, model } = agentWith({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'echo', input: 'not an object', id: 'c1' }] } : { text: 'x' }) });
        const session = await agent.session();
        const { events } = await drain(session.prompt('go'));
        expect(events.filter((e) => e.type === 'request' || e.type === 'request-resolved')).toEqual([]);
        expect(events.find((e) => e.type === 'tool-update' && e.status === 'failed')).toMatchObject({ callId: 'c1', error: expect.stringContaining('Invalid arguments for tool "echo"') });
        expect(model.requests[1]!.messages.find((m) => m.role === 'tool')!.content[0]).toMatchObject({ isError: true });
    });

    it('a request timeout denies; a tool that throws fails; cancel during a slow tool ends cancelled', async () => {
        const timeout = agentWith({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'echo', input: {}, id: 'c1' }] } : { text: 'x' }) });
        const s1 = await timeout.agent.session({ requestTimeoutMs: 5 });
        const r1 = await drain(s1.prompt('go'));
        expect(r1.events.find((e) => e.type === 'request-resolved')).toMatchObject({ by: 'timeout', outcome: 'deny' });
        expect(r1.events.find((e) => e.type === 'tool-update' && e.status === 'denied')).toBeDefined();

        const erroring = agentWith({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'failing', input: {}, id: 'c1' }] } : { text: 'x' }) });
        const s2 = await erroring.agent.session({ policy: allowAll });
        const r2 = await drain(s2.prompt('go'));
        expect(r2.events.find((e) => e.type === 'tool-update' && e.status === 'failed')).toMatchObject({ error: 'boom' });
        expect(r2.result.stopReason).toBe('end_turn');

        const slowAgent = agentWith({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'slow', input: {}, id: 'c1' }] } : { text: 'never' }) });
        const s3 = await slowAgent.agent.session({ policy: allowAll });
        const turn = s3.prompt('go');
        for await (const e of turn) if (e.type === 'tool-update' && e.status === 'in_progress') await s3.cancel();
        expect((await turn.result).stopReason).toBe('cancelled');
        expect(textOf(await collect(turn))).toBe('');
    });

    it('model errors, refusals and the step limit map onto stop reasons', async () => {
        const failing = agentWith({ script: [{ text: 'partial', error: 'the model is down' }] });
        const r1 = await drain((await failing.agent.session()).prompt('go'));
        expect(r1.result).toMatchObject({ stopReason: 'error', error: { code: 'provider_error', message: 'the model is down' } });
        expect(r1.events.find((e) => e.type === 'error')).toMatchObject({ code: 'provider_error' });

        const refusing = agentWith({ script: [{ text: 'no', finishReason: 'refusal' }] });
        expect((await (await refusing.agent.session()).prompt('go').result).stopReason).toBe('refusal');

        const looping = agentWith({ respond: () => ({ toolCalls: [{ name: 'echo', input: {} }] }) }, { maxSteps: 2 });
        const r3 = await drain((await looping.agent.session({ policy: allowAll })).prompt('go'));
        expect(r3.result.stopReason).toBe('max_turns');
        expect(r3.events.filter((e) => e.type === 'tool-update' && e.status === 'failed')).toHaveLength(1);
    });

    it('structured output rides on turn-end.output; a JSON Schema works as well as a Standard Schema', async () => {
        const { agent } = agentWith({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'echo', input: { a: 1 }, id: 'c1' }] } : { text: '{"ok":true}' }) });
        const session = await agent.session({ policy: allowAll });
        const r1 = await session.prompt('go', { output: { schema: okSchema } }).result;
        expect(r1.output).toEqual({ ok: true });
        const r2 = await session.prompt('again', { output: { schema: { type: 'object' } } }).result;
        expect(r2.output).toEqual({ ok: true });
    });

    it('resumes from a ref without a store (the ref carries the transcript) and with a store (it does not)', async () => {
        const { agent, model } = agentWith({ script: [{ text: 'one' }, { text: 'two' }] });
        const s1 = await agent.session();
        await s1.prompt('a').result;
        const ref = s1.ref;
        expect((ref.data as { transcript: unknown }).transcript).toBeDefined();
        await s1.close();
        const s2 = await agent.session({ resume: ref });
        expect(s2.id).toBe(s1.id);
        const { events } = await drain(s2.prompt('b'));
        expect(events[0]!.epoch).toBe(2);
        expect(textOf(events)).toBe('two');
        expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

        const store = memoryTranscriptStore();
        const stored = agentWith({ script: [{ text: 'one' }, { text: 'two' }] }, { store });
        const s3 = await stored.agent.session();
        await s3.prompt('a').result;
        expect(s3.ref.data).toBeUndefined();
        await s3.close();
        expect(store.size).toBe(1);
        const s4 = await stored.agent.session({ resume: s3.ref });
        expect(textOf((await drain(s4.prompt('b'))).events)).toBe('two');
        expect(stored.model.requests[1]!.messages).toHaveLength(3);
        await expect(agent.session({ resume: { agent: 'sigx', v: 1, id: 'missing' } })).rejects.toThrow(/nothing to resume/);
        await expect(agent.session({ resume: { agent: 'other', v: 1, id: 'x' } })).rejects.toThrow(/belongs to agent/);
    });

    it('imports a portable @sigx/ai transcript through the ref', async () => {
        const { agent, model } = agentWith({ script: [{ text: 'continued' }] });
        const session = await agent.session({
            resume: { agent: 'sigx', v: 1, id: 'imported', data: { messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'earlier' }] }, { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] }] } }
        });
        await session.prompt('now').result;
        expect(model.requests[0]!.messages).toEqual([{ role: 'user', content: 'earlier' }, { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }, { role: 'user', content: 'now' }]);
    });

    it('the session transcript equals a replay of its events', async () => {
        const { agent } = agentWith({ respond: (_r, round) => (round === 0 ? { toolCalls: [{ name: 'lookup', input: {}, id: 'c1' }] } : { text: 'done', usage: { outputTokens: 1 } }) });
        const session = await agent.session({ policy: allowAll });
        const all = collect(session.subscribe());
        await session.prompt('go').result;
        await session.close();
        const fromRef = (session.ref.data as { transcript: unknown }).transcript;
        const replayed = createTranscript(session.id);
        for (const e of await all) reduceAgentEvent(replayed, e);
        expect(replayed).toEqual(fromRef);
        expect(toUIMessages(replayed).map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('a session grant survives resume — from the ref and from a store', async () => {
        const grantOnce = async (session: Awaited<ReturnType<ReturnType<typeof modelAgent>['session']>>) => {
            const turn = session.prompt('go');
            for await (const e of turn) if (e.type === 'request') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'session' });
            await turn.result;
        };
        const respond: MockModelOptions['respond'] = (_req, round) => (round % 2 === 0 ? { toolCalls: [{ name: 'echo', input: { n: round }, id: `c${round}` }] } : { text: 'ok' });

        const { agent } = agentWith({ respond });
        const s1 = await agent.session();
        await grantOnce(s1);
        const ref = s1.ref;
        await s1.close();
        const s2 = await agent.session({ resume: ref });
        const { events } = await drain(s2.prompt('again'));
        expect(events.filter((e) => e.type === 'request')).toHaveLength(0);
        expect(events.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'allow', by: 'policy', ruleId: 'grant' });
        expect(events.find((e) => e.type === 'tool-update' && e.status === 'completed')).toBeDefined();

        const store = memoryTranscriptStore();
        const stored = agentWith({ respond }, { store });
        const s3 = await stored.agent.session();
        await grantOnce(s3);
        const storedRef = s3.ref;
        await s3.close();
        const s4 = await stored.agent.session({ resume: storedRef });
        const r4 = await drain(s4.prompt('again'));
        expect(r4.events.filter((e) => e.type === 'request')).toHaveLength(0);
        expect(r4.events.find((e) => e.type === 'request-resolved')).toMatchObject({ by: 'policy', ruleId: 'grant' });
    });

    it('fork: a new session seeded with a copy of the transcript, epoch reset, grants dropped', async () => {
        const { agent, model } = agentWith({ script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] });
        expect(MODEL_AGENT_CAPABILITIES.fork).toBe(true);
        const original = await agent.session();
        await original.prompt('a').result;
        const ref = original.ref;
        const forked = await agent.session({ resume: ref, fork: true });
        expect(forked.id).not.toBe(original.id);
        const { events } = await drain(forked.prompt('b'));
        expect(events[0]!.epoch).toBe(1);
        expect(events[0]!.sessionId).toBe(forked.id);
        expect(textOf(events)).toBe('two');
        // The fork carries the original conversation…
        expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        const forkedTranscript = (forked.ref.data as { transcript: { sessionId: string; grants: string[] } }).transcript;
        expect(forkedTranscript.sessionId).toBe(forked.id);
        expect(forkedTranscript.grants).toEqual([]);
        // …and the original still runs on its own.
        expect(textOf((await drain(original.prompt('c'))).events)).toBe('three');
        expect(toUIMessages((original.ref.data as { transcript: Parameters<typeof toUIMessages>[0] }).transcript)).toHaveLength(4);

        const store = memoryTranscriptStore();
        const stored = agentWith({ script: [{ text: 'one' }, { text: 'two' }] }, { store });
        const s1 = await stored.agent.session();
        await s1.prompt('a').result;
        await s1.close();
        const s2 = await stored.agent.session({ resume: s1.ref, fork: true });
        await s2.prompt('b').result;
        await s2.close();
        expect(store.size).toBe(2);
        expect(await store.load(s1.id)).toMatchObject({ messages: expect.any(Array) });
        expect((await store.load(s1.id))!.messages).toHaveLength(2);
        expect((await store.load(s2.id))!.messages).toHaveLength(4);
    });

    it('pricing turns usage into costUsd on the usage event, the result and the transcript', async () => {
        const { agent } = agentWith({ script: [{ text: 'hi', usage: { inputTokens: 10, outputTokens: 5 } }] }, { pricing: (u) => (u.outputTokens ?? 0) * 0.001 });
        const session = await agent.session();
        const all = collect(session.subscribe());
        const { events, result } = await drain(session.prompt('go'));
        expect(events.find((e) => e.type === 'usage')).toMatchObject({ scope: 'turn', costUsd: 0.005 });
        expect(result.costUsd).toBe(0.005);
        await session.prompt('again').result;
        await session.close();
        const t = createTranscript(session.id);
        for (const e of await all) reduceAgentEvent(t, e);
        expect(t.costUsd).toBeCloseTo(0.01);
        // Without pricing there is no cost.
        const plain = agentWith({ script: [{ text: 'hi', usage: { outputTokens: 5 } }] });
        expect((await (await plain.agent.session()).prompt('go').result).costUsd).toBeUndefined();
        // A pricing hook that throws or returns nonsense leaves the cost unknown; the turn still ends.
        const throwing = agentWith({ script: [{ text: 'hi', usage: { outputTokens: 5 } }] }, {
            pricing: () => {
                throw new Error('no price list');
            }
        });
        const r = await drain((await throwing.agent.session()).prompt('go'));
        expect(r.result).toMatchObject({ stopReason: 'end_turn', usage: { outputTokens: 5 } });
        expect(r.result.costUsd).toBeUndefined();
        expect(r.events.find((e) => e.type === 'usage')).not.toHaveProperty('costUsd');
        const nan = agentWith({ script: [{ text: 'hi', usage: { outputTokens: 5 } }] }, { pricing: () => Number.NaN });
        expect((await (await nan.agent.session()).prompt('go').result).costUsd).toBeUndefined();
    });

    it('prompt parts outside promptParts are refused before the turn starts', async () => {
        const { agent } = agentWith({ script: [{ text: 'hi' }] });
        const session = await agent.session();
        // Everything is accepted by our engine…
        expect((await session.prompt([{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', data: 'AA==' }]).result).stopReason).toBe('end_turn');
        expect(MODEL_AGENT_CAPABILITIES.promptParts).toBe('text+image+file');
    });
});
