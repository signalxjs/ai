/**
 * One session's pane: its settings, its transcript, its composer.
 *
 * `useAgentSession` folds the session into reactive state and the view just
 * reads it. A token is one write to one part's `text` — open devtools and
 * watch only that text node update.
 *
 * Everything here branches on CAPABILITIES, never on which agent it is.
 */
import { component } from 'sigx';
import { spawnedAgent, type ConfigOption } from '@sigx/ai-agent';
import type { AgentSessionClient } from '@sigx/ai-agent/wire';
import { useAgentSession } from '@sigx/ai-agent/app';
import { AgentCard, Ask, Message, nonBlank, type Answers } from './Thread';
import type { SessionInfo } from './catalog';

/**
 * The settings a session advertises, as controls — and the whole reason the
 * `config` event exists.
 *
 * There is no per-adapter branching here and there must never be: plan mode on
 * Claude Code is `permissionMode`, on an ACP agent it is `mode`, on Codex it is
 * `approvalPolicy` plus `sandbox`, and the model is `model` everywhere. Each
 * adapter advertises its own vocabulary and this renders whatever it says. The
 * moment a control needs special-casing here, the fix belongs in the adapter.
 */
export const ConfigPanel = component<{
    options: readonly ConfigOption[];
    /** `capabilities.config` — whether the agent has settings at all. */
    supported: boolean;
    onChange: (id: string, value: string) => void;
}>((ctx) => {
    return () => {
        const { options, supported } = ctx.props;
        if (!supported) return <p class="config-note">This agent has no live settings.</p>;
        if (options.length === 0) {
            // Claude Code (and the scripted mock) only announce their settings
            // with the first turn's `system/init`, and `configure()` before
            // that throws. Say so rather than render a panel that cannot work.
            return <p class="config-note">This agent reports its settings after its first message.</p>;
        }
        return (
            <div class="config">
                {options.map((option) => (
                    <label>
                        <span>{option.label}</span>
                        {/* One value is not a choice: show what is running,
                            rather than a dropdown that pretends to offer
                            something. */}
                        <select
                            disabled={option.values.length < 2}
                            onChange={(e) => ctx.props.onChange(option.id, (e.currentTarget as HTMLSelectElement).value)}
                        >
                            {option.values.map((value) => (
                                <option value={value.id} selected={value.id === option.current} title={value.description}>
                                    {value.label ?? value.id}
                                </option>
                            ))}
                        </select>
                    </label>
                ))}
                {/* Codex applies a change on its NEXT turn; Claude Code applies
                    it at once. Promising either would be wrong for the other. */}
                <p class="config-note">A change applies from the next message at the latest.</p>
            </div>
        );
    };
});

export const Session = component<{ session: AgentSessionClient; info: SessionInfo }>((ctx) => {
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

    /**
     * The thread's own messages. One produced inside a sub-agent renders on
     * that agent's card instead — but only when an agent claims its call, so a
     * harness that nests work without announcing an agent still shows it here.
     */
    const thread = () => view.messages.filter((m) => m.parentCallId === undefined || !spawnedAgent(view.transcript, m.parentCallId));

    /** Sub-agents no tool call spawned (ambient tasks): nothing to hang them on but the thread. */
    const ambient = () => view.agentTree.filter((node) => node.agent.callId === undefined);

    /** Capabilities, never the agent's id. */
    const busy = () => view.state === 'running' || view.state === 'awaiting';
    const steers = () => view.capabilities?.steer === true;
    const cancelAgent = () => (view.capabilities?.subagents === 'control' ? (agentId: string) => void view.cancelAgent(agentId) : undefined);

    const tokens = () => {
        const u = view.usage;
        return u ? (u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)) : 0;
    };

    return () => (
        <>
            <header>
                <h1>
                    {ctx.props.info.agentId}
                    {ctx.props.info.model ? <small class="model"> {ctx.props.info.model}</small> : null}
                </h1>
                <small>
                    {view.state}
                    {tokens() ? ` · ${tokens()} tokens` : ''}
                    {view.costUsd !== undefined ? ` · $${view.costUsd.toFixed(4)}` : ''}
                    {view.live ? '' : ' · offline'}
                </small>
            </header>
            <details class="settings">
                <summary>Settings</summary>
                <ConfigPanel options={view.config} supported={view.capabilities?.config === true} onChange={(id, value) => void view.configure({ [id]: value })} />
            </details>
            <section class="thread">
                {view.messages.length === 0 && (
                    <p class="hint">
                        Ask about the incidents. Reading is free; anything that changes the world stops and asks you. Open a second session from the sidebar to run the same prompt against another agent — or this page in a second tab, which replays every session and follows along.
                    </p>
                )}
                {thread().map((m) => (
                    <Message message={m} transcript={view.transcript} requests={view.requests} onDecide={decide} onAnswer={answer} reasoningTokens={view.usage?.reasoningTokens} onCancelAgent={cancelAgent()} />
                ))}
                {ambient().map((node) => (
                    <AgentCard agent={node.agent} transcript={view.transcript} requests={view.requests} onDecide={decide} onAnswer={answer} reasoningTokens={view.usage?.reasoningTokens} onCancelAgent={cancelAgent()} />
                ))}
                {questions().map((r) => (
                    <Ask request={r} onAnswer={answer} />
                ))}
                {/* An error is never an empty box — and never swallowed
                    either: a failure with no message still gets a line. */}
                {view.error && <p class="error">{nonBlank(view.error.message) ?? 'The session reported an error.'}</p>}
            </section>
            <form onSubmit={submit}>
                <textarea
                    rows={2}
                    aria-label="Message"
                    placeholder={busy() && steers() ? 'Steer the running turn…' : 'Message…'}
                    onInput={(e) => {
                        draft = (e.target as HTMLTextAreaElement).value;
                    }}
                    onKeyDown={onKey}
                />
                {/* An agent that cannot cancel gets no Cancel button. One that can steer keeps Send during a
                    turn, beside Cancel: the message lands inside the running turn instead of waiting for it. */}
                {busy() && view.capabilities?.cancel && (
                    <button type="button" onClick={() => void view.cancel()}>
                        Cancel
                    </button>
                )}
                {(!busy() || steers() || !view.capabilities?.cancel) && (
                    <button type="submit" disabled={busy() && !steers()}>
                        Send
                    </button>
                )}
            </form>
        </>
    );
});
