/**
 * The whole UI. `useChat` owns the transcript; the view reads it. A
 * streaming token is one write to one part's `text`, so the only thing that
 * re-renders per token is that part's `MarkdownView` — and it reads `value`
 * inside its own render, so only the markdown block still being written
 * re-renders; finalized blocks keep their DOM. Watch it in devtools.
 */
import { component, useHead } from 'sigx';
import { useChat, type UIMessage, type UIPart } from '@sigx/ai/app';
import { MarkdownView } from '@sigx/markdown/dom';
import { chat } from './ai.server';

const Part = component<{ part: UIPart; role: UIMessage['role']; live: boolean }>((ctx) => {
    return () => {
        const p = ctx.props.part;
        if (p.type === 'text') {
            // Only the assistant writes markdown; a user's text shows as typed.
            if (ctx.props.role !== 'assistant') return <span>{p.text}</span>;
            return (
                <div class={ctx.props.live ? 'md live' : 'md'}>
                    <MarkdownView value={p.text} />
                </div>
            );
        }
        if (p.type === 'reasoning') return p.text ? <div class="reasoning">{p.text}</div> : null;
        // An attachment the user sent: show what it is, not its bytes.
        if (p.type === 'image' || p.type === 'file') return <code class="attachment">{p.type === 'file' && p.filename ? p.filename : p.mediaType}</code>;
        const tail = p.state === 'pending' || p.state === 'approved' ? ' …' : p.state === 'awaiting' ? ' ? (needs approval)' : ` → ${JSON.stringify(p.output)}`;
        return (
            <code class={`tool ${p.state}`}>
                {p.name}({JSON.stringify(p.input)}){tail}
            </code>
        );
    };
});

const Message = component<{ message: UIMessage; live: boolean }>((ctx) => {
    return () => {
        const m = ctx.props.message;
        return (
            <div class={`msg ${m.role}`}>
                {m.parts.map((part, i) => (
                    <Part part={part} role={m.role} live={ctx.props.live && i === m.parts.length - 1} />
                ))}
            </div>
        );
    };
});

export const App = component(() => {
    useHead({ title: 'sigx ai — chat' });

    const thread = useChat({
        stream: (input) => chat(input),
        onError: (e) => console.error('[chat]', e)
    });

    let draft = '';

    function submit(e: Event): void {
        e.preventDefault();
        const text = draft.trim();
        if (!text) return;
        draft = '';
        const box = (e.currentTarget as HTMLFormElement).querySelector('textarea');
        if (box) box.value = '';
        void thread.send(text);
    }

    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
        }
    }

    return () => (
        <main>
            <header>
                <h1>sigx ai</h1>
                <small>status: {thread.status}</small>
            </header>
            <section class="thread">
                {thread.messages.length === 0 && <p style="opacity:.6">Say hello — ask about the weather to see a tool call, or say "email" to see one that asks first.</p>}
                {thread.messages.map((m) => (
                    <Message message={m} live={thread.streaming === m} />
                ))}
                {thread.error && <p class="error">{thread.error.message}</p>}
                {/* A tool the server deferred to us: decide, and the turn resumes. */}
                {thread.approvals.map((call) => (
                    <p class="approval">
                        Run <code>{call.name}</code>? <button type="button" onClick={() => thread.approve(call.id)}>Approve</button>{' '}
                        <button type="button" onClick={() => thread.deny(call.id, 'The user said no.')}>Deny</button>
                    </p>
                ))}
            </section>
            <form onSubmit={submit}>
                <textarea rows={2} aria-label="Message" placeholder="Message…" onInput={(e) => { draft = (e.target as HTMLTextAreaElement).value; }} onKeyDown={onKey} />
                {thread.status === 'streaming' ? (
                    <button type="button" onClick={() => thread.stop()}>Stop</button>
                ) : (
                    <button type="submit">Send</button>
                )}
            </form>
        </main>
    );
});
