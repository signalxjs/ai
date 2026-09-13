/**
 * `useChat` — the reactive transcript. Mounted in a real app (the `sigx`
 * umbrella is fine in tests), driven by `mockModel` through `chatStream`,
 * exactly the server path minus the wire.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, jsx } from 'sigx';
import { effect } from '@sigx/reactivity';
import { render } from '@sigx/runtime-dom';
import { useChat, type Chat, type UIChunk } from '@sigx/ai/app';
import { defineTool } from '@sigx/ai';
import { chatStream } from '@sigx/ai/server';
import { mockModel, type MockModelOptions } from '@sigx/ai/testing';
import { citySchema, tick } from '../helpers';

const containers: HTMLDivElement[] = [];
afterEach(() => {
    for (const c of containers.splice(0)) c.remove();
});

function mountChat(stream: (input: { messages: unknown[] }) => AsyncIterable<UIChunk>, extra?: { initialMessages?: any[] }): { chat: Chat; container: HTMLDivElement } {
    let chat!: Chat;
    const App = component(() => {
        chat = useChat({ stream: stream as any, ...extra });
        return () => (
            <div>
                <ul class="msgs">
                    {chat.messages.map((m) => (
                        <li class={m.role}>{m.parts.map((p) => (p.type === 'text' ? <span class="t">{p.text}</span> : p.type === 'tool' ? <b class="tool">{p.name}:{p.state}</b> : null))}</li>
                    ))}
                </ul>
                <i class="status">{chat.status}</i>
            </div>
        );
    }, { name: 'App' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    render(jsx(App, {}), container);
    return { chat, container };
}

const mockStream = (opts: MockModelOptions) => {
    const model = mockModel(opts);
    return { model, stream: (input: { messages: unknown[] }) => chatStream({ model, messages: input.messages as any }) };
};

describe('useChat', () => {
    it('sends, streams the reply into the last message, and settles idle', async () => {
        const { model, stream } = mockStream({ script: [{ text: 'Hello there friend', delayMs: 2 }] });
        const { chat, container } = mountChat(stream);
        expect(chat.status).toBe('idle');

        const done = chat.send('hi');
        await tick();
        expect(chat.status).toBe('streaming');
        expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        await done;

        expect(chat.status).toBe('idle');
        expect(chat.streaming).toBeNull();
        expect(container.querySelector('.assistant .t')?.textContent).toBe('Hello there friend');
        expect(container.querySelector('.status')?.textContent).toBe('idle');
        // The wire got the transcript WITH the new user message.
        expect(model.requests[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('adopts the message id the stream announces', async () => {
        let announced = '';
        const { stream } = mockStream({ script: [{ text: 'ok' }] });
        const { chat } = mountChat(async function* (input) {
            for await (const c of stream(input)) {
                if (c.type === 'start') announced = c.messageId;
                yield c;
            }
        });
        await chat.send('hi');
        expect(announced).toMatch(/^msg_/);
        expect(chat.messages[1]!.id).toBe(announced);
    });

    it('a text delta writes one part — the transcript itself does not re-run', async () => {
        const { stream } = mockStream({ script: [{ text: 'one two three four', delayMs: 2 }] });
        const { chat } = mountChat(stream);
        let listRuns = 0;
        let textRuns = 0;
        effect(() => {
            chat.messages.length;
            listRuns++;
        });
        const done = chat.send('go');
        await tick();
        const target = chat.streaming!;
        effect(() => {
            for (const p of target.parts) if (p.type === 'text') p.text;
            textRuns++;
        });
        await done;
        // 1 initial + 2 pushes (user, assistant) = 3; tokens never bump it.
        expect(listRuns).toBe(3);
        expect(textRuns).toBeGreaterThan(2);
    });

    it('stop() returns the iterator (aborting a serverStream) and keeps the partial', async () => {
        let returned = false;
        const stream = (): AsyncIterable<UIChunk> => ({
            [Symbol.asyncIterator]() {
                let i = 0;
                return {
                    next: async () => {
                        await tick();
                        return { value: i++ === 0 ? { type: 'start', messageId: 'm' } : { type: 'text', delta: 'x' }, done: false } as IteratorResult<UIChunk>;
                    },
                    return: async () => {
                        returned = true;
                        return { value: undefined, done: true };
                    }
                };
            }
        });
        const { chat } = mountChat(stream);
        const p = chat.send('go');
        await tick();
        await tick();
        await tick();
        chat.stop();
        await p;
        expect(returned).toBe(true);
        expect(chat.status).toBe('idle');
        expect(chat.messages[1]!.role).toBe('assistant');
        expect(chat.messages[1]!.parts.length).toBeGreaterThanOrEqual(1);
    });

    it('send() while streaming supersedes the running turn', async () => {
        const { model, stream } = mockStream({ script: [{ text: 'slow slow slow slow slow slow', delayMs: 3 }, { text: 'fast' }] });
        const { chat } = mountChat(stream);
        const first = chat.send('a');
        await tick();
        const second = chat.send('b');
        await Promise.all([first, second]);
        expect(model.rounds).toBe(2);
        expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(chat.messages[3]!.parts).toEqual([{ type: 'text', text: 'fast' }]);
        expect(chat.status).toBe('idle');
    });

    it('surfaces an error chunk as status error', async () => {
        const onError = vi.fn();
        const model = mockModel({ script: [{ text: 'partial', error: 'boom' }] });
        let chat!: Chat;
        const App = component(() => {
            chat = useChat({ stream: (i) => chatStream({ model, messages: i.messages }), onError });
            return () => <div />;
        });
        const c = document.createElement('div');
        containers.push(c);
        render(jsx(App, {}), c);
        await chat.send('x');
        expect(chat.status).toBe('error');
        expect(chat.error?.message).toBe('boom');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('regenerate drops the last assistant message and streams again; reset restores initial', async () => {
        const { model, stream } = mockStream({ respond: (_r, round) => ({ text: `reply ${round}` }) });
        const initial = [{ id: 'seed', role: 'user', parts: [{ type: 'text', text: 'seed' }] }];
        const { chat } = mountChat(stream, { initialMessages: initial });
        await chat.send('one');
        expect(chat.messages).toHaveLength(3);
        await chat.regenerate();
        expect(model.rounds).toBe(2);
        expect(chat.messages).toHaveLength(3);
        expect(chat.messages[2]!.parts).toEqual([{ type: 'text', text: 'reply 1' }]);
        chat.reset();
        expect(chat.messages).toHaveLength(1);
        expect(chat.messages[0]!.id).toBe('seed');
        expect(chat.status).toBe('idle');
    });

    it('refuses to send a non-user message', async () => {
        const { model, stream } = mockStream({});
        const { chat } = mountChat(stream);
        await expect(chat.send({ id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'nope' }] })).rejects.toThrow(/takes a user message/);
        expect(model.rounds).toBe(0);
        expect(chat.messages).toHaveLength(0);
    });

    it('ignores an empty send', async () => {
        const { model, stream } = mockStream({});
        const { chat } = mountChat(stream);
        await chat.send('   ');
        expect(model.rounds).toBe(0);
        expect(chat.messages).toHaveLength(0);
    });
});

describe('useChat tool approval', () => {
    const guarded = defineTool({ name: 'guarded', description: 'g', input: citySchema, needsApproval: true, execute: ({ city }) => `ran:${city}` });

    /** Round 0 asks for the guarded tool; any later round answers from the transcript. */
    const approvalStream = () => {
        const model = mockModel({
            respond: (req) => {
                const last = req.messages[req.messages.length - 1]!;
                if (last.role === 'tool') return { text: `after ${JSON.stringify(last.content[0]!.output)}` };
                return { toolCalls: [{ name: 'guarded', input: { city: 'Oslo' }, id: 'c1' }] };
            }
        });
        return { model, stream: (input: { messages: unknown[] }) => chatStream({ model, tools: [guarded], messages: input.messages as any }) };
    };

    it('stops awaiting, then approve() resumes onto the same message and runs the tool', async () => {
        const { model, stream } = approvalStream();
        const { chat, container } = mountChat(stream);
        await chat.send('go');

        expect(chat.status).toBe('awaiting');
        expect(chat.streaming).toBeNull();
        expect(chat.approvals.map((p) => p.id)).toEqual(['c1']);
        expect(container.querySelector('.tool')?.textContent).toBe('guarded:awaiting');
        expect(container.querySelector('.status')?.textContent).toBe('awaiting');
        const assistantId = chat.messages[1]!.id;

        await chat.approve('c1');
        expect(chat.status).toBe('idle');
        expect(chat.approvals).toEqual([]);
        // Same assistant message, now with the result and the follow-up text.
        expect(chat.messages).toHaveLength(2);
        expect(chat.messages[1]!.id).toBe(assistantId);
        expect(chat.messages[1]!.parts).toEqual([
            { type: 'tool', id: 'c1', name: 'guarded', input: { city: 'Oslo' }, state: 'done', output: 'ran:Oslo' },
            { type: 'text', text: 'after "ran:Oslo"' }
        ]);
        expect(container.querySelector('.tool')?.textContent).toBe('guarded:done');
        // The resumed request carried the approved call; the model then saw its result.
        expect(model.rounds).toBe(2);
        expect(model.requests[1]!.messages[2]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'c1', output: 'ran:Oslo' }] });
    });

    it('deny() sends the reason back as an error result', async () => {
        const { model, stream } = approvalStream();
        const { chat, container } = mountChat(stream);
        await chat.send('go');
        expect(chat.status).toBe('awaiting');

        await chat.deny('c1', 'not allowed here');
        expect(chat.status).toBe('idle');
        expect(chat.messages[1]!.parts[0]).toEqual({ type: 'tool', id: 'c1', name: 'guarded', input: { city: 'Oslo' }, state: 'denied', output: 'not allowed here' });
        expect(container.querySelector('.tool')?.textContent).toBe('guarded:denied');
        expect(model.requests[1]!.messages[2]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'c1', output: 'not allowed here', isError: true }] });
    });

    it('waits until every call is decided, and ignores unknown or settled ids', async () => {
        const model = mockModel({
            respond: (req) => {
                const last = req.messages[req.messages.length - 1]!;
                if (last.role === 'tool') return { text: 'end' };
                return { toolCalls: [{ name: 'guarded', input: { city: 'A' }, id: 'c1' }, { name: 'guarded', input: { city: 'B' }, id: 'c2' }] };
            }
        });
        const { chat } = mountChat((input) => chatStream({ model, tools: [guarded], messages: input.messages as any }));
        await chat.send('go');
        expect(chat.approvals.map((p) => p.id)).toEqual(['c1', 'c2']);

        await chat.approve('nope');
        await chat.approve('c1');
        expect(chat.status).toBe('awaiting');
        expect(chat.approvals.map((p) => p.id)).toEqual(['c2']);
        await chat.approve('c1'); // already decided — a no-op
        expect(model.rounds).toBe(1);

        await chat.deny('c2');
        expect(chat.status).toBe('idle');
        expect(chat.messages[1]!.parts.map((p) => (p.type === 'tool' ? p.state : p.type))).toEqual(['done', 'denied', 'text']);
    });

    it('send() while awaiting denies the leftovers so the transcript stays whole', async () => {
        const { model, stream } = approvalStream();
        const { chat } = mountChat(stream);
        await chat.send('go');
        expect(chat.status).toBe('awaiting');
        await chat.send('never mind');
        expect(chat.status).toBe('awaiting'); // the new turn asks again
        expect(chat.messages[1]!.parts[0]).toMatchObject({ state: 'denied', output: 'Skipped by the user.' });
        expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        // The skipped call reached the model as an error result.
        expect(model.requests[1]!.messages[2]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'c1', isError: true }] });
    });
});
