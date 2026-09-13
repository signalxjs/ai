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

type Answers = Record<string, string | string[]>;

/** One answerable field, read off the request's `schema` — a picker, a multi-picker, or free text. */
interface Field {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly multi: boolean;
    readonly choices: readonly string[];
    /** The schema leaves the value open, so an answer off the list is legal ("Other"). */
    readonly freeText: boolean;
}

type Schema = Record<string, unknown>;
const asSchema = (v: unknown): Schema | undefined => (typeof v === 'object' && v !== null ? (v as Schema) : undefined);

/**
 * `schema` → fields. One property per question: an array is a multi-select, an
 * `enum` (plain, or under an `anyOf` branch) lists the choices, and a branch
 * that leaves the string open means free text is allowed too.
 */
function fieldsOf(request: OpenRequest): Field[] {
    const properties = asSchema(asSchema(request.schema)?.properties);
    if (!properties) return [{ id: 'answer', title: 'Answer', multi: false, choices: [], freeText: true }];
    return Object.entries(properties).map(([id, raw]) => {
        const prop = asSchema(raw) ?? {};
        const multi = prop.type === 'array';
        const value = (multi ? asSchema(prop.items) : prop) ?? {};
        const branches = (Array.isArray(value.anyOf) ? value.anyOf : []).map(asSchema);
        const closed = Array.isArray(value.enum) ? (value.enum as unknown[]) : undefined;
        const choices = (closed ?? branches.find((b) => Array.isArray(b?.enum))?.enum ?? []) as string[];
        return {
            id,
            title: typeof prop.title === 'string' ? prop.title : id,
            ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
            multi,
            choices: choices.map(String),
            freeText: !closed && (choices.length === 0 || branches.some((b) => b?.type === 'string' && b.enum === undefined))
        };
    });
}

/** The form's values, in the shape `respond({ type: 'input', answers })` wants. */
function readAnswers(form: HTMLFormElement, fields: readonly Field[]): Answers {
    const data = new FormData(form);
    const answers: Answers = {};
    for (const f of fields) {
        const other = String(data.get(`${f.id}:other`) ?? '').trim();
        // A question nobody answered is LEFT OUT, never sent as `''` or `[]`:
        // the adapter reports exactly what it was given, and an empty value
        // would read as answered on this side and unanswered on the other.
        if (f.multi) {
            const picked = [...data.getAll(f.id).map(String), ...(other ? [other] : [])].filter((v) => v !== '');
            if (picked.length) answers[f.id] = picked;
        } else {
            const picked = other || String(data.get(f.id) ?? '');
            if (picked) answers[f.id] = picked;
        }
    }
    return answers;
}

/**
 * An input request as a real form: radios for a single choice, checkboxes for
 * a multi-select, and a free-text box wherever the schema leaves the value
 * open. Submitting answers every question in one `respond`.
 */
const Ask = component<{ request: OpenRequest; onAnswer: (requestId: string, answers: Answers) => void }>((ctx) => {
    return () => {
        const request = ctx.props.request;
        const fields = fieldsOf(request);
        return (
            <form
                class="ask"
                onSubmit={(e: Event) => {
                    e.preventDefault();
                    ctx.props.onAnswer(request.requestId, readAnswers(e.currentTarget as HTMLFormElement, fields));
                }}
            >
                {fields.map((f) => (
                    <fieldset class="question">
                        <legend>{f.title}</legend>
                        {f.description && <p class="question-text">{f.description}</p>}
                        {f.choices.map((choice) => (
                            <label>
                                <input type={f.multi ? 'checkbox' : 'radio'} name={f.id} value={choice} /> {choice}
                            </label>
                        ))}
                        {f.freeText && <input type="text" name={`${f.id}:other`} aria-label={`Other — ${f.title}`} placeholder={f.choices.length ? 'Other…' : 'Your answer…'} />}
                    </fieldset>
                ))}
                <button type="submit">Answer</button>
            </form>
        );
    };
});

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

/**
 * What a part needs from the session: the open requests and the two ways to
 * settle one, plus the live reasoning-token count — the only progress a
 * harness that redacts its thinking gives us.
 */
interface ThreadProps {
    readonly requests: readonly OpenRequest[];
    readonly onDecide: (requestId: string, allow: boolean) => void;
    readonly onAnswer: (requestId: string, answers: Answers) => void;
    readonly reasoningTokens?: number;
}

const Part = component<{ part: AgentPart } & ThreadProps>((ctx) => {
    return () => {
        const p = ctx.props.part;
        if (p.type === 'text') return <span class="text">{p.text}</span>;
        if (p.type === 'reasoning') {
            // Four states, and only two of them have text to show. A harness
            // that redacts thinking (Claude Code) opens a REAL reasoning part
            // whose text stays empty for the whole thinking window, so
            // rendering `null` on empty text is ten seconds of blank thread
            // (#78). While the part is open, say that it is thinking — with
            // the neutral `usage.reasoningTokens` count once one arrives;
            // once it has ended with nothing to show, there is nothing to say.
            if (!p.text) {
                const n = ctx.props.reasoningTokens;
                return p.done ? null : <div class="reasoning thinking">Thinking…{n ? ` ${n} tokens` : ''}</div>;
            }
            // Exposed reasoning is long: open while it streams, folded away
            // once it is done — the same `<details>` treatment as tool input.
            return (
                <details class="reasoning" open={!p.done}>
                    <summary>{p.done ? 'Thought' : 'Thinking…'}</summary>
                    {p.text}
                </details>
            );
        }
        if (p.type === 'image' || p.type === 'file') return <code class="attachment">{p.type === 'file' && p.filename ? p.filename : p.mediaType}</code>;
        if (p.type !== 'tool') return null;
        // A tool card: name, input, status — and, while the call waits on the
        // operator, the prompt in place on the card: Allow/Deny for a
        // permission, the answer form for a question (Claude Code's
        // `AskUserQuestion` arrives as an input request ON its tool call).
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
                {open?.kind === 'input' && <Ask request={open} onAnswer={ctx.props.onAnswer} />}
                {open && open.kind !== 'input' && (
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

const Message = component<{ message: AgentMessage } & ThreadProps>((ctx) => {
    return () => (
        <div class={`msg ${ctx.props.message.role}`}>
            {ctx.props.message.parts.map((part) => (
                <Part part={part} requests={ctx.props.requests} onDecide={ctx.props.onDecide} onAnswer={ctx.props.onAnswer} reasoningTokens={ctx.props.reasoningTokens} />
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

    function answer(requestId: string, answers: Answers): void {
        void view.respond(requestId, { type: 'input', answers });
    }

    /** Questions with no tool call of their own; the rest render on their card. */
    const questions = () => view.requests.filter((r) => r.kind === 'input' && r.callId === undefined);

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
                    <Message message={m} requests={view.requests} onDecide={decide} onAnswer={answer} reasoningTokens={view.usage?.reasoningTokens} />
                ))}
                {questions().map((r) => (
                    <Ask request={r} onAnswer={answer} />
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
