/**
 * The whole UI. `connectSession` turns the two server stubs into an
 * `AgentSession`; `useAgentSession` folds its events into a reactive
 * transcript. The view just reads that transcript — a streaming token is one
 * write to one part's `text`, so the only thing that re-renders per token is
 * that part's text node.
 *
 * Open a SECOND TAB: it asks for `(0, 0)`, replays the conversation and then
 * follows it live — because the session lives on the server and its events
 * are numbered. Approve a tool in one tab and watch the other one update.
 *
 * The connection is opened on MOUNT, never during SSR: a server render has
 * no business holding a subscription it cannot close.
 */
import { component, useHead, onMounted, onUnmounted, signal } from 'sigx';
import { toolOutput } from '@sigx/ai-agent';
import { connectSession, type AgentSessionClient } from '@sigx/ai-agent/wire';
import { useAgentSession, type AgentMessage, type AgentPart, type OpenRequest, type ToolPartState } from '@sigx/ai-agent/app';
import { agentCommand, agentEvents } from './agent.server';

/** The transport: two functions over the build-swapped server stubs. */
function connect(): Promise<AgentSessionClient> {
    return connectSession(
        {
            send: (command) => agentCommand({ command }),
            events: (from) => agentEvents(from ? { from } : {})
        },
        // From the very beginning: a tab opened an hour late shows the whole
        // conversation, not just what happens next.
        { from: { epoch: 0, seq: 0 } }
    );
}

/** What a card shows before it elides — a card summarises, the `<details>` has the rest. */
const HEAD_CHARS = 72;
const OUTPUT_LINES = 24;
const OUTPUT_CHARS = 4000;

/** One line, whitespace collapsed, capped. */
function oneLine(text: string, max = HEAD_CHARS): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The call signature for the card header: the FIRST argument, summarised —
 * `Bash(command: ls -la)`, not the forty lines of nested JSON an
 * `AskUserQuestion` input is. The full input is one `<details>` away.
 */
function signature(input: unknown): string {
    if (input === undefined || input === null) return '';
    if (typeof input !== 'object') return oneLine(String(input));
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return '';
    const [name, value] = entries[0]!;
    const shown = oneLine(`${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return entries.length > 1 ? `${shown}, +${entries.length - 1}` : shown;
}

/** Keep the head AND the tail: a listing is worth reading at both ends. */
function elide(text: string): string {
    let out = text;
    const lines = out.split('\n');
    if (lines.length > OUTPUT_LINES) {
        const head = lines.slice(0, Math.ceil(OUTPUT_LINES / 2));
        const tail = lines.slice(lines.length - Math.floor(OUTPUT_LINES / 2));
        out = [...head, `… ${lines.length - head.length - tail.length} lines omitted …`, ...tail].join('\n');
    }
    // One huge line survives the line cap; cap the characters too.
    if (out.length > OUTPUT_CHARS) {
        const half = Math.floor(OUTPUT_CHARS / 2);
        out = `${out.slice(0, half)}\n… ${out.length - OUTPUT_CHARS} characters omitted …\n${out.slice(out.length - half)}`;
    }
    return out;
}

/**
 * The output block, as TEXT. A string is already text — `JSON.stringify` on
 * one is what turned a shell listing into a single quoted line of `\n`
 * escapes, inside a `<pre>`. `toolOutput` collapses `output` and the
 * `content` blocks a harness may send instead; anything that is not a string
 * is pretty-printed JSON. The error has its own line, so it stays out.
 */
function outputText(p: ToolPartState): string | undefined {
    if (p.output === undefined && !p.content?.length) return undefined;
    const out = toolOutput(p);
    return elide(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
}

const Part = component<{ part: AgentPart; requests: readonly OpenRequest[]; onDecide: (requestId: string, allow: boolean) => void }>((ctx) => {
    return () => {
        const p = ctx.props.part;
        if (p.type === 'text') return <span class="text">{p.text}</span>;
        if (p.type === 'reasoning') return p.text ? <div class="reasoning">{p.text}</div> : null;
        if (p.type === 'image' || p.type === 'file') return <code class="attachment">{p.type === 'file' && p.filename ? p.filename : p.mediaType}</code>;
        if (p.type !== 'tool') return null;
        // A tool card: name, input, status — and, while the call waits on the
        // operator, the permission prompt in place on the card.
        const open = p.requestId ? ctx.props.requests.find((r) => r.requestId === p.requestId) : undefined;
        const sig = signature(p.input);
        const output = outputText(p);
        return (
            <div class={`tool ${p.status}`}>
                <code class="tool-head">
                    {p.title ?? p.name}({sig})
                </code>
                <span class="tool-status">{p.status}</span>
                {sig !== '' && (
                    <details class="tool-input">
                        <summary>input</summary>
                        <pre>{JSON.stringify(p.input, null, 2)}</pre>
                    </details>
                )}
                {output !== undefined && <pre class="tool-output">{output}</pre>}
                {p.error && <span class="tool-error">{p.error}</span>}
                {open && (
                    <p class="ask">
                        Allow <code>{open.toolName ?? p.name}</code>?{' '}
                        <button type="button" onClick={() => ctx.props.onDecide(open.requestId, true)}>
                            Allow
                        </button>{' '}
                        <button type="button" onClick={() => ctx.props.onDecide(open.requestId, false)}>
                            Deny
                        </button>
                    </p>
                )}
            </div>
        );
    };
});

const Message = component<{ message: AgentMessage; requests: readonly OpenRequest[]; onDecide: (requestId: string, allow: boolean) => void }>((ctx) => {
    return () => (
        <div class={`msg ${ctx.props.message.role}`}>
            {ctx.props.message.parts.map((part) => (
                <Part part={part} requests={ctx.props.requests} onDecide={ctx.props.onDecide} />
            ))}
        </div>
    );
});

/** The session view — mounted once the connection exists. */
const Session = component<{ session: AgentSessionClient }>((ctx) => {
    const view = useAgentSession(ctx.props.session, {
        onError: (e) => console.error('[agent]', e)
    });

    let draft = '';

    function decide(requestId: string, allow: boolean): void {
        void view.respond(requestId, {
            type: 'permission',
            outcome: allow ? 'allow' : 'deny',
            // `session` remembers the answer under the request's
            // `permissionKey`, so the same call is never asked twice.
            scope: allow ? 'session' : 'once',
            ...(allow ? {} : { message: 'The operator said no.' })
        });
    }

    function submit(e: Event): void {
        e.preventDefault();
        const text = draft.trim();
        if (!text) return;
        draft = '';
        const box = (e.currentTarget as HTMLFormElement).querySelector('textarea');
        if (box) box.value = '';
        void view.prompt(text);
    }

    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
        }
    }

    /** An `input` question has no tool call of its own; tool permissions render on their card. */
    const questions = () => view.requests.filter((r) => r.callId === undefined);

    const tokens = () => {
        const u = view.usage;
        return u ? (u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)) : 0;
    };

    return () => (
        <>
            <header>
                <h1>sigx agent</h1>
                <small>
                    {view.state}
                    {tokens() ? ` · ${tokens()} tokens` : ''}
                    {view.costUsd !== undefined ? ` · $${view.costUsd.toFixed(4)}` : ''}
                    {view.live ? '' : ' · offline'}
                </small>
            </header>
            <section class="thread">
                {view.messages.length === 0 && (
                    <p class="hint">Ask about the incidents: the read-only tool runs unasked, the destructive one stops and asks you. Then open this page in a second tab — it replays everything and follows along.</p>
                )}
                {view.messages.map((m) => (
                    <Message message={m} requests={view.requests} onDecide={decide} />
                ))}
                {questions().map((r) => (
                    <p class="ask">
                        {r.message ?? 'The agent is asking for input.'}{' '}
                        <button type="button" onClick={() => void view.respond(r.requestId, { type: 'input', answers: 'ok' })}>
                            Answer “ok”
                        </button>
                    </p>
                ))}
                {view.error && <p class="error">{view.error.message}</p>}
            </section>
            <form onSubmit={submit}>
                <textarea
                    rows={2}
                    aria-label="Message"
                    placeholder="Message…"
                    onInput={(e) => {
                        draft = (e.target as HTMLTextAreaElement).value;
                    }}
                    onKeyDown={onKey}
                />
                {/* Capabilities, never the agent's id: an agent that cannot cancel does not get a Cancel button. */}
                {view.capabilities?.cancel && (view.state === 'running' || view.state === 'awaiting') ? (
                    <button type="button" onClick={() => void view.cancel()}>
                        Cancel
                    </button>
                ) : (
                    <button type="submit" disabled={view.state === 'running'}>
                        Send
                    </button>
                )}
            </form>
        </>
    );
});

export const App = component(() => {
    useHead({ title: 'sigx ai — agent' });

    // The client is a live object, not state: keep it out of the proxy and
    // flip one flag when it is ready.
    let client: AgentSessionClient | null = null;
    const status = signal({ ready: false, error: '' });

    onMounted(() => {
        connect().then(
            (session) => {
                client = session;
                status.ready = true;
            },
            (e: unknown) => {
                status.error = e instanceof Error ? e.message : String(e);
            }
        );
    });

    // Ours to close: `useAgentSession` unsubscribes on unmount, but the
    // connection belongs to whoever opened it.
    onUnmounted(() => client?.disconnect());

    return () => <main>{status.ready && client ? <Session session={client} /> : status.error ? <p class="error">{status.error}</p> : <p class="hint">Connecting…</p>}</main>;
});
