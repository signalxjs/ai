import { describe, it, expect } from 'vitest';
import { toChatStream, allowAll } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import { assembleMessage, type UIChunk } from '@sigx/ai';
import { collect } from '../helpers';

describe('toChatStream', () => {
    it('renders a turn as UI chunks that assemble into a message', async () => {
        const agent = mockAgent({
            script: [[{ reasoning: 'hm', text: 'Hello world' }, { tool: { name: 'read', input: { p: 1 }, output: 'ok' } }, { tool: { name: 'bad', status: 'failed', error: 'boom' } }, { usage: { outputTokens: 3 } }]]
        });
        const session = await agent.session({ policy: allowAll });
        const chunks = await collect(toChatStream(session.prompt('go')));
        expect(chunks[0]).toMatchObject({ type: 'start' });
        expect(chunks.map((c) => c.type)).toEqual(['start', 'reasoning', 'reasoning-end', 'text', 'text', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'finish']);
        expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop', usage: { outputTokens: 3 } });
        const { message } = await assembleMessage((async function* () {
            yield* chunks;
        })());
        expect(message.parts).toEqual([
            { type: 'reasoning', text: 'hm' },
            { type: 'text', text: 'Hello world' },
            { type: 'tool', id: 'call_1', name: 'read', input: { p: 1 }, state: 'done', output: 'ok' },
            { type: 'tool', id: 'call_2', name: 'bad', input: null, state: 'error', output: 'boom' }
        ]);
    });

    it('a permission request becomes tool-approval-request; a denial is a denied tool result', async () => {
        const agent = mockAgent({ script: [[{ tool: { name: 'rm' } }]] });
        const session = await agent.session();
        // A client answers through the session; here a side task plays the client.
        const client = (async () => {
            for await (const e of session.subscribe()) {
                if (e.type === 'request') {
                    await session.respond(e.requestId, { type: 'permission', outcome: 'deny', scope: 'once', message: 'not today' });
                    return;
                }
            }
        })();
        const chunks = await collect(toChatStream(session.prompt('go')));
        await client;
        expect(chunks.map((c) => c.type)).toEqual(['start', 'tool-call', 'tool-approval-request', 'tool-result', 'finish']);
        expect(chunks[3]).toEqual({ type: 'tool-result', id: 'call_1', output: 'not today', isError: true, denied: true });
    });

    it('a failed turn ends with exactly one error chunk; a cancelled one finishes with other', async () => {
        const failing = mockAgent({ script: [[{ text: 'partial' }, { error: { code: 'provider_error', message: 'nope' } }]] });
        const s1 = await failing.session();
        const c1 = await collect(toChatStream(s1.prompt('go')));
        expect(c1.filter((c) => c.type === 'error' || c.type === 'finish')).toEqual([{ type: 'error', message: 'nope' }]);

        const slow = mockAgent({ script: [[{ tool: { name: 'slow', delayMs: 500 } }]] });
        const s2 = await slow.session({ policy: allowAll });
        const turn = s2.prompt('go');
        const c2: UIChunk[] = [];
        for await (const c of toChatStream(turn)) {
            c2.push(c);
            if (c.type === 'tool-call') await s2.cancel();
        }
        expect(c2.at(-1)).toEqual({ type: 'finish', reason: 'other' });
    });
});

describe('toChatStream: progressive tool input', () => {
    it('becomes the `tool-input` chunk useChat already understands, and folds to ONE part', async () => {
        const agent = mockAgent({
            script: [[{ tool: { name: 'weather', input: { city: 'Paris' }, inputDeltas: ['{"ci', 'ty":"Pa', 'ris"}'], output: 'sunny' } }]]
        });
        const session = await agent.session({ policy: allowAll });
        const chunks = await collect(toChatStream(session.prompt('go')));

        const inputs = chunks.filter((c): c is Extract<UIChunk, { type: 'tool-input' }> => c.type === 'tool-input');
        expect(inputs.map((c) => c.delta)).toEqual(['{"ci', 'ty":"Pa', 'ris"}']);
        expect(inputs.every((c) => c.name === 'weather')).toBe(true);

        // The two protocols agreeing is the whole point: assembling the chunks
        // the @sigx/ai way gives one settled part, not two.
        const { message } = await assembleMessage(
            (async function* () {
                yield* chunks;
            })()
        );
        const tools = message.parts.filter((p) => p.type === 'tool');
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({ name: 'weather', input: { city: 'Paris' }, state: 'done' });
    });
});
