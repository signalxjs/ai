/**
 * `useChat` — a reactive transcript driven by a chunk stream.
 *
 * The transcript is ONE reactive proxy (`signal({ messages })`); the
 * streaming assistant message is the last element of it, and a text delta
 * is `part.text += delta` on the proxied part — a single property write,
 * observed by the one text node that reads it. The transcript, the
 * composer and the other messages never re-render.
 *
 * Single-threaded like `useAction`: `send()` while a turn streams stops the
 * running turn first. `stop()` calls the chunk iterator's `return()`, which
 * for a `serverStream` stub aborts the request and runs the handler's
 * `finally`. Unmount stops the pull too.
 */

import { signal, batch, untrack } from '@sigx/reactivity';
import { getCurrentInstance } from '@sigx/runtime-core';
import { applyChunk } from '../messages.js';
import { createMessage, userMessage, type UIChunk, type UIMessage, type Usage } from '../protocol.js';

export type ChatStatus = 'idle' | 'streaming' | 'error';

export interface ChatStreamInput {
    readonly messages: UIMessage[];
}

export interface UseChatOptions {
    /**
     * The turn source — typically a `serverStream` stub:
     * `(input) => chat(input)`. Receives the transcript INCLUDING the new
     * user message; yields the assistant's chunks.
     */
    readonly stream: (input: ChatStreamInput) => AsyncIterable<UIChunk>;
    readonly initialMessages?: readonly UIMessage[];
    /** Called once per completed turn with the finished assistant message. */
    readonly onFinish?: (message: UIMessage, info: { readonly usage?: Usage }) => void;
    readonly onError?: (error: Error) => void;
}

export interface Chat {
    /** The transcript — reactive; read it in a view. */
    readonly messages: UIMessage[];
    readonly status: ChatStatus;
    readonly error: Error | null;
    /** The message being streamed, or `null` between turns. */
    readonly streaming: UIMessage | null;
    /** Append a user message and stream the reply. Resolves when the turn ends. */
    send(input: string | UIMessage): Promise<void>;
    /** Abort the running turn; the partial assistant message stays. */
    stop(): void;
    /** Drop the last assistant message and stream it again. */
    regenerate(): Promise<void>;
    /** Back to `initialMessages`, idle. */
    reset(): void;
}

export function useChat(options: UseChatOptions): Chat {
    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('[sigx ai] useChat() must be called inside component setup.');
    }
    const initial = () => (options.initialMessages ?? []).map(cloneMessage);

    // Two signals, not one: the transcript is its own top-level object
    // signal so `$set` (reset) is typed and a status flip never touches the
    // array's dependents.
    const messages = signal(initial() as UIMessage[]);
    const state = signal({
        status: 'idle' as ChatStatus,
        error: null as Error | null,
        streamingIndex: -1
    });

    /** Supersede token: bumped by every send(), stop(), reset(), and unmount. */
    let seq = 0;
    let current: AsyncIterator<UIChunk> | null = null;

    function stopCurrent(): void {
        seq++;
        const it = current;
        current = null;
        if (it) void it.return?.().catch(() => {});
    }

    async function run(): Promise<void> {
        stopCurrent();
        const id = seq;

        // Plain (unproxied) copies go on the wire; the proxied transcript is
        // what the view reads.
        const wire = untrack(() => messages.map(cloneMessage));
        const assistant = createMessage('assistant');
        untrack(() =>
            batch(() => {
                messages.push(assistant);
                state.streamingIndex = messages.length - 1;
                state.status = 'streaming';
                state.error = null;
            })
        );
        // The proxied message — writes through it are what the view observes.
        const target = untrack(() => messages[state.streamingIndex]!);

        let usage: Usage | undefined;
        try {
            const iterable = options.stream({ messages: wire });
            const it = iterable[Symbol.asyncIterator]();
            current = it;
            for (;;) {
                const next = await it.next();
                if (id !== seq) return; // superseded: never writes state
                if (next.done) break;
                const chunk = next.value;
                if (chunk.type === 'error') throw new Error(chunk.message);
                if (chunk.type === 'finish') {
                    usage = chunk.usage;
                    break;
                }
                untrack(() => applyChunk(target, chunk));
            }
            if (id !== seq) return;
            current = null;
            untrack(() =>
                batch(() => {
                    state.status = 'idle';
                    state.streamingIndex = -1;
                })
            );
            options.onFinish?.(untrack(() => cloneMessage(target)), usage ? { usage } : {});
        } catch (e) {
            if (id !== seq) return;
            current = null;
            const err = e instanceof Error ? e : new Error(String(e));
            untrack(() =>
                batch(() => {
                    state.status = 'error';
                    state.error = err;
                    state.streamingIndex = -1;
                })
            );
            options.onError?.(err);
        }
    }

    async function send(input: string | UIMessage): Promise<void> {
        const message = typeof input === 'string' ? userMessage(input) : cloneMessage(input);
        if (message.role === 'user' && !message.parts.some((p) => p.type === 'text' && p.text.trim())) return;
        stopCurrent();
        untrack(() => {
            // A stopped turn leaves its partial assistant message; a new send
            // continues after it, which is what a chat does.
            messages.push(message);
        });
        await run();
    }

    function stop(): void {
        if (untrack(() => state.status) !== 'streaming') return;
        stopCurrent();
        untrack(() =>
            batch(() => {
                state.status = 'idle';
                state.streamingIndex = -1;
            })
        );
    }

    async function regenerate(): Promise<void> {
        stopCurrent();
        untrack(() => {
            while (messages.length && messages[messages.length - 1]!.role === 'assistant') messages.pop();
        });
        if (untrack(() => messages.length) === 0) {
            untrack(() => batch(() => { state.status = 'idle'; state.streamingIndex = -1; }));
            return;
        }
        await run();
    }

    function reset(): void {
        stopCurrent();
        untrack(() =>
            batch(() => {
                messages.$set(initial());
                state.status = 'idle';
                state.error = null;
                state.streamingIndex = -1;
            })
        );
    }

    instance.onUnmounted(() => {
        stopCurrent();
    });

    return {
        get messages() {
            return messages;
        },
        get status() {
            return state.status;
        },
        get error() {
            return state.error;
        },
        get streaming() {
            const i = state.streamingIndex;
            return i >= 0 ? (messages[i] ?? null) : null;
        },
        send,
        stop,
        regenerate,
        reset
    };
}

/** A structural copy — drops proxies, keeps ids. */
function cloneMessage(m: UIMessage): UIMessage {
    return {
        id: m.id,
        role: m.role,
        parts: m.parts.map((p) => ({ ...p })),
        ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {})
    };
}
