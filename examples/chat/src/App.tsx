/**
 * The whole UI. `useChat` owns the transcript; the view reads it. A
 * streaming token is one write to one part's `text`, so the only thing that
 * re-renders per token is that part's `RichTextView` — and it reads `value`
 * inside its own render, so only the markdown block still being written
 * re-renders; finalized blocks keep their DOM. Watch it in devtools.
 */
import { component, useHead, onMounted, signal } from 'sigx';
import { useChat, type UIMessage, type UIPart } from '@sigx/ai/app';
import { RichTextView } from '@sigx/richtext/dom';
import { markdownFormat } from '@sigx/richtext-markdown';
import { catalog, chat } from './ai.server';
import type { ChatCatalog, ProviderId, Selection } from './catalog';

const Part = component<{ part: UIPart; role: UIMessage['role']; live: boolean }>((ctx) => {
    return () => {
        const p = ctx.props.part;
        if (p.type === 'text') {
            // Only the assistant writes markdown; a user's text shows as typed.
            if (ctx.props.role !== 'assistant') return <span>{p.text}</span>;
            return (
                <div class={ctx.props.live ? 'md live' : 'md'}>
                    <RichTextView value={p.text} format={markdownFormat} />
                </div>
            );
        }
        if (p.type === 'reasoning') return p.text ? <div class="reasoning">{p.text}</div> : null;
        // An attachment the user sent: show what it is, not its bytes.
        if (p.type === 'image' || p.type === 'file') return <code class="attachment">{p.type === 'file' && p.filename ? p.filename : p.mediaType}</code>;
        // Arguments still arriving: show the raw JSON as it lands, so a long
        // input reads as a stream rather than a spinner.
        if (p.state === 'streaming')
            return (
                <code class="tool streaming">
                    {p.name}({p.inputText ?? ''}…)
                </code>
            );
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


/**
 * Provider and model, per conversation. Exported so a test can mount it: what
 * it puts on the wire is the contract, and it lives nowhere else.
 *
 * Only providers whose key is actually set are offered — the server filters
 * the catalogue it serves, so an unusable provider is never a choice that
 * fails at request time.
 */
export const ModelPicker = component<{
    catalog: ChatCatalog | undefined;
    selection: Selection;
    disabled: boolean;
    onChange: (selection: Selection) => void;
}>((ctx) => {
    const providerOf = (id: ProviderId) => ctx.props.catalog?.providers.find((p) => p.id === id);
    return () => {
        const cat = ctx.props.catalog;
        if (!cat) return <small class="picker-loading">loading models…</small>;
        const current = providerOf(ctx.props.selection.provider);
        return (
            <div class="picker">
                <select
                    aria-label="Provider"
                    disabled={ctx.props.disabled}
                    onChange={(e) => {
                        const provider = (e.currentTarget as HTMLSelectElement).value as ProviderId;
                        // A provider change has to carry a model that provider
                        // owns, or the server's allowlist refuses the pair.
                        const first = providerOf(provider)?.models[0]?.id;
                        if (first) ctx.props.onChange({ provider, model: first });
                    }}
                >
                    {cat.providers.map((p) => (
                        <option value={p.id} selected={p.id === ctx.props.selection.provider}>
                            {p.label}
                        </option>
                    ))}
                </select>
                <select
                    aria-label="Model"
                    disabled={ctx.props.disabled}
                    onChange={(e) => ctx.props.onChange({ provider: ctx.props.selection.provider, model: (e.currentTarget as HTMLSelectElement).value })}
                >
                    {(current?.models ?? []).map((m) => (
                        <option value={m.id} selected={m.id === ctx.props.selection.model}>
                            {m.label}
                        </option>
                    ))}
                </select>
            </div>
        );
    };
});

export const App = component(() => {
    useHead({ title: 'sigx ai — chat' });

    // `useChat` hands its `stream` only `{ messages }`, so the selection is
    // closed over here rather than threaded through the package.
    const state = signal<{ catalog: ChatCatalog | undefined; selection: Selection }>({
        catalog: undefined,
        // Replaced by the server's default the moment the catalogue lands; the
        // mock is the one choice that is always available until then.
        selection: { provider: 'mock', model: 'mock-1' }
    });

    const thread = useChat({
        stream: (input) => chat({ ...input, selection: state.selection }),
        onError: (e) => console.error('[chat]', e)
    });

    // On MOUNT: a server render must not fetch, and the picker has a usable
    // default until it does.
    onMounted(() => {
        void catalog({}).then(
            (cat) => {
                state.catalog = cat;
                state.selection = cat.selected;
            },
            (e: unknown) => console.error('[chat]', e)
        );
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
                <ModelPicker
                    catalog={state.catalog}
                    selection={state.selection}
                    /* Mid-turn is the one time it must not move: the reply
                       arriving belongs to the model that started it. */
                    disabled={thread.status === 'streaming'}
                    onChange={(selection) => (state.selection = selection)}
                />
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
