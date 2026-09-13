import { describe, it, expect } from 'vitest';
import { defineTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { agentTool, modelAgent, allowAll, createTranscript, reduceAgentEvent, type AgentEvent } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { collect } from '../helpers';

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
        expect(nested.map((e) => e.type)).toEqual(['part-start', 'part-delta', 'part-delta', 'part-end', 'tool-call', 'tool-update', 'request-resolved', 'tool-update', 'tool-update', 'ext']);
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

    // Pinned red: the delegate's `usage` events are forwarded into the host turn and summed into the
    // host session's totals. #92 attributes them to the sub-agent instead and flips this to `it`.
    it.fails('child usage is attributed to the delegate, not summed into the host session totals', async () => {
        const delegate = mockAgent({ script: [[{ text: 'x' }, { usage: { inputTokens: 100, outputTokens: 50 } }]] });
        const ask = agentTool(delegate, { name: 'ask', description: 'x', input: question, prompt: (i) => i.question });
        const model = mockModel({ respond: (_r, round) => ({ ...(round === 0 ? { toolCalls: [{ name: 'ask', input: { question: 'q' }, id: 'host1' }] } : { text: 'Summary.' }), usage: { inputTokens: 10, outputTokens: 5 } }) });
        const session = await modelAgent({ model, tools: [ask] }).session({ policy: allowAll });
        const all = collect(session.subscribe());
        await session.prompt('go').result;
        await session.close();
        const t = createTranscript(session.id);
        for (const e of await all) reduceAgentEvent(t, e);
        expect(t.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    });

    it('a plain defineTool still works as a host tool alongside agentTool', () => {
        const plain = defineTool({ name: 'plain', description: 'x', input: question, execute: (i) => i.question });
        expect(plain.spec.name).toBe('plain');
    });
});
