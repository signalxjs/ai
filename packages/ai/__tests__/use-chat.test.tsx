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
import { chatStream } from '@sigx/ai/server';
import { mockModel, type MockModelOptions } from '@sigx/ai/testing';
import { tick } from './helpers';

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

    it('ignores an empty send', async () => {
        const { model, stream } = mockStream({});
        const { chat } = mountChat(stream);
        await chat.send('   ');
        expect(model.rounds).toBe(0);
        expect(chat.messages).toHaveLength(0);
    });
});
