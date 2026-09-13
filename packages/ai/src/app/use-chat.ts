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
 *
 * A tool the server defers to the client (`needsApproval` through
 * `chatStream`) leaves the turn `awaiting`: `approvals` lists the calls,
 * `approve(id)` / `deny(id)` decide them, and once nothing is left undecided
 * the transcript goes back to the server, which resumes the same assistant
 * message where it stopped.
 */

import { signal, batch, untrack } from '@sigx/reactivity';
import { getCurrentInstance } from '@sigx/runtime-core';
import { DENIED_MESSAGE } from '../model/index.js';
import { applyChunk } from '../protocol/index.js';
import { createMessage, userMessage, type UIChunk, type UIMessage, type UIToolPart, type Usage } from '../protocol/index.js';

/** `awaiting`: the turn stopped on tool calls the user must approve or deny. */
export type ChatStatus = 'idle' | 'streaming' | 'awaiting' | 'error';

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
    /** Called once per completed turn with the finished assistant message (and the structured `output`, when the server asked for one). */
    readonly onFinish?: (message: UIMessage, info: { readonly usage?: Usage; readonly output?: unknown }) => void;
    readonly onError?: (error: Error) => void;
}

export interface Chat {
    /** The transcript — reactive; read it in a view. */
    readonly messages: UIMessage[];
    readonly status: ChatStatus;
    readonly error: Error | null;
    /** The message being streamed, or `null` between turns. */
    readonly streaming: UIMessage | null;
    /** Tool calls waiting for a decision (status `awaiting`); empty otherwise. */
    readonly approvals: readonly UIToolPart[];
    /**
     * Append a user message and stream the reply. Resolves when the turn ends
     * — or stops to ask about a tool (status `awaiting`). Sending while
     * awaiting denies the undecided calls first.
     */
    send(input: string | UIMessage): Promise<void>;
    /** Let an awaiting call run. Once nothing is left undecided, the turn resumes. */
    approve(id: string): Promise<void>;
    /** Refuse an awaiting call; the model is told `reason`. Once nothing is left undecided, the turn resumes. */
    deny(id: string, reason?: string): Promise<void>;
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
    // `activeIndex` is the assistant message of the turn in flight — streaming,
    // or stopped awaiting a decision.
    const state = signal({
        status: 'idle' as ChatStatus,
        error: null as Error | null,
        activeIndex: -1
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

    /**
     * One request to the server. A fresh turn appends an assistant
     * placeholder; a RESUMED turn (after approvals) streams onto the existing
     * last assistant message — the server re-announces its id, so `start` is
     * a no-op and the new results land on the parts the user decided.
     */
    async function run(resume = false): Promise<void> {
        stopCurrent();
        const id = seq;

        // Plain (unproxied) copies go on the wire; the proxied transcript is
        // what the view reads.
        const wire = untrack(() => messages.map(cloneMessage));
        untrack(() =>
            batch(() => {
                if (!resume) messages.push(createMessage('assistant'));
                state.activeIndex = messages.length - 1;
                state.status = 'streaming';
                state.error = null;
            })
        );
        // The proxied message — writes through it are what the view observes.
        const target = untrack(() => messages[state.activeIndex]!);

        let usage: Usage | undefined;
        let output: unknown;
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
                    output = chunk.output;
                    break;
                }
                untrack(() => applyChunk(target, chunk));
            }
            if (id !== seq) return;
            current = null;
            // A turn that stopped on undecided calls is not finished: it waits
            // for `approve` / `deny`, keeps its message active, and `onFinish`
            // fires when the resumed turn completes.
            if (untrack(() => awaitingParts(target)).length) {
                untrack(() => {
                    state.status = 'awaiting';
                });
                return;
            }
            untrack(() =>
                batch(() => {
                    state.status = 'idle';
                    state.activeIndex = -1;
                })
            );
            options.onFinish?.(untrack(() => cloneMessage(target)), { ...(usage ? { usage } : {}), ...(output !== undefined ? { output } : {}) });
        } catch (e) {
            if (id !== seq) return;
            current = null;
            const err = e instanceof Error ? e : new Error(String(e));
            untrack(() =>
                batch(() => {
                    state.status = 'error';
                    state.error = err;
                    state.activeIndex = -1;
                })
            );
            options.onError?.(err);
        }
    }

    /** Record a decision on an awaiting call; resume once every call is decided. */
    async function decide(id: string, decision: (part: UIToolPart) => void): Promise<void> {
        const active = untrack(() => (state.status === 'awaiting' ? messages[state.activeIndex] : undefined));
        if (!active) return;
        const part = untrack(() => active.parts.find((p): p is UIToolPart => p.type === 'tool' && p.id === id && p.state === 'awaiting'));
        if (!part) return;
        untrack(() => decision(part));
        if (untrack(() => awaitingParts(active)).length) return;
        await run(true);
    }

    function approve(id: string): Promise<void> {
        return decide(id, (part) => {
            part.state = 'approved';
        });
    }

    function deny(id: string, reason?: string): Promise<void> {
        return decide(id, (part) => {
            part.state = 'denied';
            part.output = reason ?? DENIED_MESSAGE;
        });
    }

    async function send(input: string | UIMessage): Promise<void> {
        const message = typeof input === 'string' ? userMessage(input) : cloneMessage(input);
        // `send` appends a USER turn — an assistant message here would put the
        // transcript in a shape no provider accepts, so it is a caller error.
        if (message.role !== 'user') {
            throw new Error(`[sigx ai] useChat.send() takes a user message; got role "${message.role}". Use initialMessages for a seeded transcript.`);
        }
        // Nothing to say: no text with content and no attachment.
        if (!message.parts.some((p) => (p.type === 'text' && p.text.trim()) || p.type === 'image' || p.type === 'file')) return;
        stopCurrent();
        untrack(() => {
            // Moving on from an awaiting turn decides its open calls as denied,
            // so the transcript the model sees has a result for every call.
            if (state.status === 'awaiting') {
                for (const p of awaitingParts(messages[state.activeIndex]!)) {
                    p.state = 'denied';
                    p.output = 'Skipped by the user.';
                }
            }
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
                state.activeIndex = -1;
            })
        );
    }

    async function regenerate(): Promise<void> {
        stopCurrent();
        untrack(() => {
            while (messages.length && messages[messages.length - 1]!.role === 'assistant') messages.pop();
        });
        if (untrack(() => messages.length) === 0) {
            untrack(() => batch(() => { state.status = 'idle'; state.activeIndex = -1; }));
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
                state.activeIndex = -1;
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
            const i = state.activeIndex;
            return state.status === 'streaming' && i >= 0 ? (messages[i] ?? null) : null;
        },
        get approvals() {
            const i = state.activeIndex;
            return state.status === 'awaiting' && i >= 0 ? awaitingParts(messages[i]!) : [];
        },
        send,
        approve,
        deny,
        stop,
        regenerate,
        reset
    };
}

function awaitingParts(message: UIMessage): UIToolPart[] {
    return message.parts.filter((p): p is UIToolPart => p.type === 'tool' && p.state === 'awaiting');
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
