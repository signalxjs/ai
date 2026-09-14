/**
 * The transcript itself: a message, a part, a tool card, a sub-agent card.
 *
 * Split out of `App.tsx` when the playground grew a sidebar, and unchanged by
 * that move. It imports nothing from the server module, which is what lets the
 * DOM test mount `Part` without stubbing anything.
 *
 * One rule runs through all of it: **an element is for content that exists,
 * never for content that is merely present.** A tool that completed with an
 * empty output gets one dim `no output`, not a padded empty `<pre>`; a blank
 * sub-agent summary gets no `<p>`; a blank error gets no `<span>`.
 */
import { component } from 'sigx';
import { agentMessages, childAgents, toolOutput } from '@sigx/ai-agent';
import type { AgentMessage, AgentPart, AgentState, AgentTranscript, OpenRequest, ToolPartState } from '@sigx/ai-agent/app';

export type Answers = Record<string, string | string[]>;

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
export const Ask = component<{ request: OpenRequest; onAnswer: (requestId: string, answers: Answers) => void }>((ctx) => {
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
 * Text worth putting in an element — `undefined` for anything that would
 * render blank. A block element drawn around nothing is not "empty", it is a
 * grey rectangle that says nothing (#128), and it is the same defect as the
 * blank assistant bubble in #71. Every branch below that opens a box guards on
 * this, never on mere presence.
 */
export function nonBlank(text: string | undefined): string | undefined {
    return text !== undefined && text.trim() !== '' ? text : undefined;
}

/** Did the tool report a result at all? Absent (still running, or a harness that reports none) is not the same as empty. */
function reportedOutput(p: ToolPartState): boolean {
    return p.output !== undefined || !!p.content?.length;
}

/**
 * The output block, as TEXT. A string is already text — `JSON.stringify` on
 * one is what turned a shell listing into a single quoted line of `\n`
 * escapes, inside a `<pre>`. `toolOutput` collapses `output` and the
 * `content` blocks a harness may send instead; anything that is not a string
 * is pretty-printed JSON. The error has its own line, so it stays out.
 *
 * A result that renders blank is `undefined` here — there is no text to put
 * in the `<pre>`, so there is no `<pre>`. The card says so in one dim word
 * instead; `reportedOutput` is what tells "returned nothing" from "has not
 * returned".
 */
function outputText(p: ToolPartState): string | undefined {
    if (!reportedOutput(p)) return undefined;
    const out = toolOutput(p);
    return nonBlank(elide(typeof out === 'string' ? out : JSON.stringify(out, null, 2)));
}

/**
 * What a part needs from the session: the open requests and the two ways to
 * settle one, plus the live reasoning-token count — the only progress a
 * harness that shows none of its thinking gives us. A tool card that spawned
 * a sub-agent reads the agent and its messages from the `transcript`.
 */
export interface ThreadProps {
    readonly requests: readonly OpenRequest[];
    readonly onDecide: (requestId: string, allow: boolean) => void;
    readonly onAnswer: (requestId: string, answers: Answers) => void;
    readonly reasoningTokens?: number;
    readonly transcript: AgentTranscript;
    /** Stop one sub-agent — passed only when the agent controls its sub-agents (`subagents: 'control'`). */
    readonly onCancelAgent?: (agentId: string) => void;
}

/** Exported for `__tests__/app.test.tsx`: what a part renders is the thing worth asserting on. */
export const Part = component<{ part: AgentPart } & ThreadProps>((ctx) => {
    return () => {
        const p = ctx.props.part;
        if (p.type === 'text') return <span class="text">{p.text}</span>;
        if (p.type === 'reasoning') {
            // Four states, and only two of them have text to show. A harness
            // that shows none of its thinking (Claude Code under
            // `thinking.display: 'omitted'`) still opens a REAL reasoning
            // part whose text stays empty for the whole thinking window, so
            // rendering `null` on empty text is ten seconds of blank thread
            // (#78). While the part is open, say that it is thinking — with
            // the neutral `usage.reasoningTokens` count once one arrives;
            // once it has ended with nothing to show, there is nothing to say.
            const thought = nonBlank(p.text);
            if (!thought) {
                const n = ctx.props.reasoningTokens;
                return p.done ? null : <div class="reasoning thinking">Thinking…{n ? ` ${n} tokens` : ''}</div>;
            }
            // Exposed reasoning is long: open while it streams, folded away
            // once it is done — the same `<details>` treatment as tool input.
            return (
                <details class="reasoning" open={!p.done}>
                    <summary>{p.done ? 'Thought' : 'Thinking…'}</summary>
                    {thought}
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
        const error = nonBlank(p.error);
        // The call spawned a sub-agent (its `agent-start` set `agentId`): its card hangs under this one.
        const agent = p.agentId !== undefined ? ctx.props.transcript.agents[p.agentId] : undefined;
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
                {/* It ran and handed back nothing: one dim word, so "returned
                    empty" still reads differently from "has not returned". */}
                {output === undefined && reportedOutput(p) && <span class="tool-empty">no output</span>}
                {error && <span class="tool-error">{error}</span>}
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
                {agent && (
                    <AgentCard
                        agent={agent}
                        transcript={ctx.props.transcript}
                        requests={ctx.props.requests}
                        onDecide={ctx.props.onDecide}
                        onAnswer={ctx.props.onAnswer}
                        reasoningTokens={ctx.props.reasoningTokens}
                        onCancelAgent={ctx.props.onCancelAgent}
                    />
                )}
            </div>
        );
    };
});

/**
 * A sub-agent card: who it is, its status, and — folded away once it is done
 * — its own messages, rendered with the same `Message` and `Part` as the
 * thread. That is the recursion: a sub-agent's tool call that spawns another
 * one carries its own card, one level deeper. A child with no spawning call
 * (an ambient task) has nothing to hang on, so it follows at the end.
 *
 * Cancel stops THIS agent and leaves the turn running. It is offered from the
 * `subagents: 'control'` capability, never from who the agent is.
 */
export const AgentCard = component<{ agent: AgentState } & ThreadProps>((ctx) => {
    return () => {
        const { agent, transcript } = ctx.props;
        const messages = agentMessages(transcript, agent.agentId);
        const ambient = childAgents(transcript, agent.agentId).filter((child) => child.callId === undefined);
        const running = agent.status === 'running' || agent.status === 'paused';
        const cancel = ctx.props.onCancelAgent;
        // Same rule as the tool card: a summary or an error that reads blank
        // opens no element. The status pill and the card's colour already say
        // that it failed, so there is nothing left unsaid.
        const summary = nonBlank(agent.summary === undefined ? undefined : oneLine(agent.summary));
        const error = nonBlank(agent.error?.message);
        return (
            <div class={`agent ${agent.status}`}>
                <div class="agent-head">
                    <strong>{agent.title ?? agent.kind ?? 'sub-agent'}</strong>
                    <span class="agent-status">{agent.status}</span>
                    {cancel && running && (
                        <button type="button" onClick={() => cancel(agent.agentId)}>
                            Cancel
                        </button>
                    )}
                </div>
                {summary && <p class="agent-summary">{summary}</p>}
                {error && <span class="tool-error">{error}</span>}
                {messages.length > 0 && (
                    <details class="agent-work" open={running}>
                        <summary>{running ? 'Working…' : `Its work (${messages.length} message${messages.length === 1 ? '' : 's'})`}</summary>
                        {messages.map((m) => (
                            <Message
                                message={m}
                                transcript={transcript}
                                requests={ctx.props.requests}
                                onDecide={ctx.props.onDecide}
                                onAnswer={ctx.props.onAnswer}
                                reasoningTokens={ctx.props.reasoningTokens}
                                onCancelAgent={cancel}
                            />
                        ))}
                    </details>
                )}
                {ambient.map((child) => (
                    <AgentCard
                        agent={child}
                        transcript={transcript}
                        requests={ctx.props.requests}
                        onDecide={ctx.props.onDecide}
                        onAnswer={ctx.props.onAnswer}
                        reasoningTokens={ctx.props.reasoningTokens}
                        onCancelAgent={cancel}
                    />
                ))}
            </div>
        );
    };
});

export const Message = component<{ message: AgentMessage } & ThreadProps>((ctx) => {
    return () => (
        <div class={`msg ${ctx.props.message.role}`}>
            {ctx.props.message.parts.map((part) => (
                <Part
                    part={part}
                    transcript={ctx.props.transcript}
                    requests={ctx.props.requests}
                    onDecide={ctx.props.onDecide}
                    onAnswer={ctx.props.onAnswer}
                    reasoningTokens={ctx.props.reasoningTokens}
                    onCancelAgent={ctx.props.onCancelAgent}
                />
            ))}
        </div>
    );
});
