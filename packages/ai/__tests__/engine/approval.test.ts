/**
 * Tool approval in the engine — `needsApproval`, `onToolApproval`, the
 * `awaiting` / `denied` states and resume mode for client-driven approvals.
 */
import { describe, it, expect, vi } from 'vitest';
import { streamText, generateText, defineTool, userMessage, type UIChunk, type UIMessage } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { citySchema, collect } from '../helpers';

const guarded = defineTool({
    name: 'guarded',
    description: 'Needs a human',
    input: citySchema,
    needsApproval: true,
    annotations: { destructive: true },
    execute: async ({ city }) => `ran:${city}`
});

const open = defineTool({
    name: 'open',
    description: 'Runs freely',
    input: citySchema,
    execute: async ({ city }) => `free:${city}`
});

/** Round 0 calls the given tools, round 1 answers. */
const twoRounds = (calls: { name: string; city: string; id: string }[]) =>
    mockModel({
        respond: (req, round) =>
            round === 0
                ? { toolCalls: calls.map((c) => ({ name: c.name, input: { city: c.city }, id: c.id })) }
                : { text: `done after ${req.messages.length}` }
    });

const results = (chunks: UIChunk[]) => chunks.filter((c): c is Extract<UIChunk, { type: 'tool-result' }> => c.type === 'tool-result');
const types = (chunks: UIChunk[]) => chunks.map((c) => c.type);

describe('streamText tool approval', () => {
    it('asks before a guarded call and runs it when allowed', async () => {
        const model = twoRounds([{ name: 'guarded', city: 'Oslo', id: 'c1' }]);
        const onToolApproval = vi.fn(async () => 'allow' as const);
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [guarded], onToolApproval }));
        expect(types(chunks)).toEqual(['start', 'tool-call', 'tool-approval-request', 'tool-result', 'text', 'text', 'text', 'finish']);
        expect(chunks[2]).toEqual({ type: 'tool-approval-request', id: 'c1' });
        expect(results(chunks)).toEqual([{ type: 'tool-result', id: 'c1', output: 'ran:Oslo' }]);
        expect(onToolApproval).toHaveBeenCalledWith({ id: 'c1', name: 'guarded', input: { city: 'Oslo' } }, { signal: expect.any(AbortSignal) });
    });

    it('a denial becomes an error result with the reason, and the loop continues', async () => {
        const model = twoRounds([{ name: 'guarded', city: 'Oslo', id: 'c1' }]);
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [guarded], onToolApproval: async () => ({ deny: 'not today' }) as const }));
        expect(results(chunks)).toEqual([{ type: 'tool-result', id: 'c1', output: 'not today', isError: true, denied: true }]);
        expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: 'stop' });
        // The model saw the denial as an error result.
        expect(model.requests[1]!.messages[2]).toEqual({
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'guarded', output: 'not today', isError: true }]
        });
    });

    it('a plain deny carries a default message', async () => {
        const model = twoRounds([{ name: 'guarded', city: 'Oslo', id: 'c1' }]);
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [guarded], onToolApproval: async () => 'deny' as const }));
        expect(results(chunks)[0]).toMatchObject({ id: 'c1', isError: true, denied: true, output: expect.stringMatching(/denied/i) });
    });

    it('never runs a guarded tool without a handler — it is denied with a clear message', async () => {
        const model = twoRounds([{ name: 'guarded', city: 'Oslo', id: 'c1' }]);
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [guarded] }));
        expect(results(chunks)[0]).toMatchObject({ id: 'c1', isError: true, denied: true, output: expect.stringMatching(/requires approval.*onToolApproval/) });
    });

    it('a tool without needsApproval never asks', async () => {
        const model = twoRounds([{ name: 'open', city: 'Oslo', id: 'c1' }]);
        const onToolApproval = vi.fn(async () => 'deny' as const);
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [open], onToolApproval }));
        expect(types(chunks)).not.toContain('tool-approval-request');
        expect(results(chunks)).toEqual([{ type: 'tool-result', id: 'c1', output: 'free:Oslo' }]);
        expect(onToolApproval).not.toHaveBeenCalled();
    });

    it('a needsApproval predicate sees the validated input; a validation failure is an error result', async () => {
        const picky = defineTool({
            name: 'picky',
            description: 'p',
            input: citySchema,
            needsApproval: ({ city }) => city === 'Oslo',
            execute: ({ city }) => `ok:${city}`
        });
        const model = mockModel({
            respond: (_req, round) =>
                round === 0
                    ? { toolCalls: [{ name: 'picky', input: { city: 'Oslo' }, id: 'a' }, { name: 'picky', input: { city: 'Rome' }, id: 'b' }, { name: 'picky', input: { city: 1 }, id: 'c' }] }
                    : { text: 'end' }
        });
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [picky], onToolApproval: async () => 'allow' as const }));
        expect(chunks.filter((c) => c.type === 'tool-approval-request')).toEqual([{ type: 'tool-approval-request', id: 'a' }]);
        expect(results(chunks)).toEqual([
            { type: 'tool-result', id: 'a', output: 'ok:Oslo' },
            { type: 'tool-result', id: 'b', output: 'ok:Rome' },
            { type: 'tool-result', id: 'c', output: expect.stringMatching(/Invalid arguments/), isError: true }
        ]);
    });

    it('parallel calls with mixed decisions land in ONE tool message', async () => {
        const model = twoRounds([
            { name: 'guarded', city: 'A', id: 'c1' },
            { name: 'open', city: 'B', id: 'c2' },
            { name: 'guarded', city: 'C', id: 'c3' }
        ]);
        const chunks = await collect(
            streamText({
                model,
                messages: [userMessage('go')],
                tools: [guarded, open],
                onToolApproval: async (call) => ((call.input as { city: string }).city === 'A' ? ('allow' as const) : ('deny' as const))
            })
        );
        expect(chunks.filter((c) => c.type === 'tool-approval-request').map((c) => (c as { id: string }).id)).toEqual(['c1', 'c3']);
        expect(results(chunks)).toEqual([
            { type: 'tool-result', id: 'c1', output: 'ran:A' },
            { type: 'tool-result', id: 'c2', output: 'free:B' },
            { type: 'tool-result', id: 'c3', output: expect.any(String), isError: true, denied: true }
        ]);
        const toolMsg = model.requests[1]!.messages[2]!;
        expect(toolMsg.role).toBe('tool');
        expect((toolMsg as unknown as { content: unknown[] }).content).toHaveLength(3);
    });

    it('aborting while an approval is pending ends the turn as a cancellation', async () => {
        const model = twoRounds([{ name: 'guarded', city: 'Oslo', id: 'c1' }]);
        const ctrl = new AbortController();
        const chunks: UIChunk[] = [];
        for await (const c of streamText({
            model,
            messages: [userMessage('go')],
            tools: [guarded],
            signal: ctrl.signal,
            onToolApproval: () => new Promise(() => {}) // never decides
        })) {
            chunks.push(c);
            if (c.type === 'tool-approval-request') ctrl.abort();
        }
        expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: 'other' });
        expect(model.rounds).toBe(1);
    });

    it("'defer' leaves the call unrun and ends the turn with finish 'tool'", async () => {
        const model = twoRounds([
            { name: 'guarded', city: 'A', id: 'c1' },
            { name: 'open', city: 'B', id: 'c2' }
        ]);
        const chunks = await collect(streamText({ model, messages: [userMessage('go')], tools: [guarded, open], onToolApproval: async () => 'defer' as const }));
        expect(types(chunks)).toEqual(['start', 'tool-call', 'tool-call', 'tool-approval-request', 'tool-result', 'finish']);
        // The free call ran; the guarded one has no result.
        expect(results(chunks)).toEqual([{ type: 'tool-result', id: 'c2', output: 'free:B' }]);
        expect(chunks[chunks.length - 1]).toEqual({ type: 'finish', reason: 'tool' });
        expect(model.rounds).toBe(1);
    });

    it('resumes a transcript with approved and denied calls: one tool message, then a model round', async () => {
        const model = mockModel({ respond: (req) => ({ text: `saw ${req.messages.length}` }) });
        const transcript: UIMessage[] = [
            userMessage('go', 'u1'),
            {
                id: 'a1',
                role: 'assistant',
                parts: [
                    { type: 'text', text: 'Let me.' },
                    { type: 'tool', id: 'c1', name: 'guarded', input: { city: 'A' }, state: 'approved' },
                    { type: 'tool', id: 'c2', name: 'open', input: { city: 'B' }, state: 'done', output: 'free:B' },
                    { type: 'tool', id: 'c3', name: 'guarded', input: { city: 'C' }, state: 'denied', output: 'no way' }
                ]
            }
        ];
        const onToolApproval = vi.fn(async (_call: unknown, ctx: { approvedByClient?: true }) => (ctx.approvedByClient ? ('allow' as const) : ('deny' as const)));
        const chunks = await collect(streamText({ model, messages: transcript, tools: [guarded, open], onToolApproval }));
        // No model round for the resumed calls; the start re-announces the message.
        expect(chunks[0]).toEqual({ type: 'start', messageId: 'a1' });
        // Only the newly settled result is streamed; the approved call is not announced again,
        // but the handler still sees it — flagged as the client's decision.
        expect(types(chunks)).toEqual(['start', 'tool-result', 'text', 'text', 'finish']);
        expect(results(chunks)).toEqual([{ type: 'tool-result', id: 'c1', output: 'ran:A' }]);
        expect(onToolApproval).toHaveBeenCalledTimes(1);
        expect(onToolApproval).toHaveBeenCalledWith({ id: 'c1', name: 'guarded', input: { city: 'A' } }, { signal: expect.any(AbortSignal), approvedByClient: true });
        expect(model.rounds).toBe(1);
        expect(model.requests[0]!.messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me.' },
                    { type: 'tool-call', id: 'c1', name: 'guarded', input: { city: 'A' } },
                    { type: 'tool-call', id: 'c2', name: 'open', input: { city: 'B' } },
                    { type: 'tool-call', id: 'c3', name: 'guarded', input: { city: 'C' } }
                ]
            },
            {
                role: 'tool',
                content: [
                    { type: 'tool-result', toolCallId: 'c1', toolName: 'guarded', output: 'ran:A' },
                    { type: 'tool-result', toolCallId: 'c2', toolName: 'open', output: 'free:B' },
                    { type: 'tool-result', toolCallId: 'c3', toolName: 'guarded', output: 'no way', isError: true }
                ]
            }
        ]);
    });

    it("a client's approval alone runs nothing: the server handler can veto, and no handler denies", async () => {
        const transcript: UIMessage[] = [
            userMessage('go', 'u1'),
            { id: 'a1', role: 'assistant', parts: [{ type: 'tool', id: 'c1', name: 'guarded', input: { city: 'A' }, state: 'approved' }] }
        ];
        const vetoed = await collect(streamText({ model: mockModel({ script: [{ text: 'end' }] }), messages: transcript, tools: [guarded], onToolApproval: async () => ({ deny: 'policy says no' }) as const }));
        expect(results(vetoed)).toEqual([{ type: 'tool-result', id: 'c1', output: 'policy says no', isError: true, denied: true }]);

        const bare = await collect(streamText({ model: mockModel({ script: [{ text: 'end' }] }), messages: transcript, tools: [guarded] }));
        expect(results(bare)).toEqual([{ type: 'tool-result', id: 'c1', output: expect.stringMatching(/requires approval/), isError: true, denied: true }]);
    });

    it('resumes a still-awaiting call by asking again', async () => {
        const model = mockModel({ script: [{ text: 'end' }] });
        const transcript: UIMessage[] = [
            userMessage('go', 'u1'),
            { id: 'a1', role: 'assistant', parts: [{ type: 'tool', id: 'c1', name: 'guarded', input: { city: 'A' }, state: 'awaiting' }] }
        ];
        const deferred = await collect(streamText({ model, messages: transcript, tools: [guarded], onToolApproval: async () => 'defer' as const }));
        expect(types(deferred)).toEqual(['start', 'tool-approval-request', 'finish']);
        expect(deferred[deferred.length - 1]).toEqual({ type: 'finish', reason: 'tool' });
        expect(model.rounds).toBe(0);

        const allowed = await collect(streamText({ model, messages: transcript, tools: [guarded], onToolApproval: async () => 'allow' as const }));
        expect(types(allowed)).toEqual(['start', 'tool-approval-request', 'tool-result', 'text', 'finish']);
    });

    it('generateText over a resumed transcript returns the whole assistant message', async () => {
        const model = mockModel({ script: [{ text: 'end' }] });
        const transcript: UIMessage[] = [
            userMessage('go', 'u1'),
            {
                id: 'a1',
                role: 'assistant',
                parts: [
                    { type: 'text', text: 'Let me.' },
                    { type: 'tool', id: 'c1', name: 'guarded', input: { city: 'A' }, state: 'approved' },
                    { type: 'tool', id: 'c2', name: 'open', input: { city: 'B' }, state: 'done', output: 'free:B' }
                ]
            }
        ];
        const r = await generateText({ model, messages: transcript, tools: [guarded, open], onToolApproval: (_c, ctx) => (ctx.approvedByClient ? 'allow' : 'deny') });
        expect(r.message.id).toBe('a1');
        expect(r.message.parts).toEqual([
            { type: 'text', text: 'Let me.' },
            { type: 'tool', id: 'c1', name: 'guarded', input: { city: 'A' }, state: 'done', output: 'ran:A' },
            { type: 'tool', id: 'c2', name: 'open', input: { city: 'B' }, state: 'done', output: 'free:B' },
            { type: 'text', text: 'end' }
        ]);
        expect(r.toolCalls.map((c) => c.id)).toEqual(['c1', 'c2']);
        expect(r.text).toBe('Let me.end');
        // The caller's transcript was not mutated.
        expect(transcript[1]!.parts[1]).toMatchObject({ state: 'approved' });
    });

    it('generateText reports a denied call as an error', async () => {
        const model = twoRounds([{ name: 'guarded', city: 'Oslo', id: 'c1' }]);
        const r = await generateText({ model, messages: [userMessage('go')], tools: [guarded], onToolApproval: async () => 'deny' as const });
        expect(r.toolCalls).toEqual([{ id: 'c1', name: 'guarded', input: { city: 'Oslo' }, output: expect.any(String), isError: true }]);
        expect(r.message.parts[0]).toMatchObject({ type: 'tool', state: 'denied' });
    });
});
