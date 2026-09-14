/**
 * The playground shell: a sidebar of live sessions, a New-session form, and a
 * pane per session.
 *
 * **The sessions are not in the browser.** Each pane holds a *view* of a log
 * that lives on the server, addressed by `(epoch, seq)` — which is why
 * switching sessions here, a second tab, a reconnect after a dropped
 * connection and a phone opened an hour later all converge on the same
 * transcript without any of them being special-cased.
 *
 * Panes are hidden, never unmounted. `useAgentSession` captures its source in
 * setup, so an unkeyed pane reused for a different session would keep folding
 * the old one; keeping every pane mounted also means switching costs nothing
 * and side-by-side comparison is one class away.
 */
import { component, useHead, onMounted, onUnmounted } from 'sigx';
import { Session } from './Session';
import { createPlayground } from './sessions';
import { modeOf, type AgentChoice, type CatalogEntry } from './catalog';

/** One row in the sidebar: what it is, what it is doing, and how to close it. */
const SessionRow = component<{
    label: string;
    model: string | undefined;
    mode: string | undefined;
    state: string;
    selected: boolean;
    onSelect: () => void;
    onClose: () => void;
}>((ctx) => {
    return () => (
        <div class={`session-row ${ctx.props.selected ? 'selected' : ''} ${ctx.props.state}`}>
            <button type="button" class="session-pick" onClick={ctx.props.onSelect}>
                <span class="session-name">{ctx.props.label}</span>
                <span class="session-meta">
                    {[ctx.props.model, ctx.props.mode, ctx.props.state].filter(Boolean).join(' · ')}
                </span>
            </button>
            <button type="button" class="session-close" aria-label="Close session" onClick={ctx.props.onClose}>
                ×
            </button>
        </div>
    );
});

/**
 * Open another one. An agent that failed last time is offered greyed out with
 * the reason on it, rather than hidden — you should be able to see that Codex
 * is installed-but-not-signed-in without guessing why it vanished.
 */
const NewSession = component<{
    agents: readonly CatalogEntry[];
    defaults: { agent: AgentChoice; model?: string; cwd: string };
    full: boolean;
    onOpen: (agent: AgentChoice, model: string | undefined, cwd: string | undefined) => void;
}>((ctx) => {
    let agent: AgentChoice = ctx.props.defaults.agent;
    let model: string | undefined = ctx.props.defaults.model;
    let cwd: string = ctx.props.defaults.cwd;
    // Re-rendered on change so the model/cwd fields follow the chosen agent.
    const entry = () => ctx.props.agents.find((a) => a.id === agent);

    function submit(e: Event): void {
        e.preventDefault();
        ctx.props.onOpen(agent, model, entry()?.needsCwd ? cwd : undefined);
    }

    return () => (
        <form class="new-session" onSubmit={submit}>
            <label>
                <span>Agent</span>
                <select
                    onChange={(e) => {
                        agent = (e.currentTarget as HTMLSelectElement).value as AgentChoice;
                        model = ctx.props.agents.find((a) => a.id === agent)?.models[0]?.id;
                    }}
                >
                    {ctx.props.agents.map((a) => (
                        <option value={a.id} selected={a.id === agent} disabled={Boolean(a.unavailable)} title={a.unavailable ?? a.install}>
                            {a.label}
                            {a.unavailable ? ' — unavailable' : ''}
                        </option>
                    ))}
                </select>
            </label>
            {/* A harness reports its models once it is up, so there is nothing
                honest to offer here — the pane's Settings panel is where you
                switch it. */}
            {entry() && entry()!.models.length > 0 && (
                <label>
                    <span>Model</span>
                    <select onChange={(e) => (model = (e.currentTarget as HTMLSelectElement).value)}>
                        {entry()!.models.map((m) => (
                            <option value={m.id} selected={m.id === model}>
                                {m.label ?? m.id}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {entry()?.needsCwd && (
                <label>
                    <span>Directory</span>
                    <input type="text" value={cwd} onInput={(e) => (cwd = (e.currentTarget as HTMLInputElement).value)} />
                </label>
            )}
            <button type="submit" disabled={ctx.props.full}>
                New session
            </button>
            {ctx.props.full && <p class="hint">The session limit is reached — close one first.</p>}
        </form>
    );
});

export const App = component(() => {
    useHead({ title: 'sigx ai — agent playground' });
    const pg = createPlayground();
    const { state } = pg;

    // Everything happens on MOUNT. A server render must open no session and no
    // subscription — and opening-when-empty during SSR would start one per
    // page render.
    onMounted(() => {
        void (async () => {
            try {
                await pg.refresh();
                // Out of the box: land in a conversation rather than a form.
                if (state.rows.length === 0 && state.catalog) await pg.open({ agent: state.catalog.defaults.agent, ...(state.catalog.defaults.model ? { model: state.catalog.defaults.model } : {}) });
            } catch (e) {
                state.error = e instanceof Error ? e.message : String(e);
                state.ready = true;
            }
        })();
    });

    // The connections belong to whoever opened them. Dropping them leaves the
    // sessions running on the server — which is the point.
    onUnmounted(() => pg.disconnectAll());

    const label = (agent: AgentChoice) => state.catalog?.agents.find((a) => a.id === agent)?.label ?? agent;

    return () => (
        <main class={`layout ${state.compare ? 'compare' : ''}`}>
            <aside class="sidebar">
                <h1>agent playground</h1>
                {state.rows.map((row) => (
                    <SessionRow
                        label={label(row.agent)}
                        model={row.model}
                        mode={modeOf(row.config)}
                        state={row.state}
                        selected={row.sessionId === state.selected}
                        onSelect={() => pg.select(row.sessionId)}
                        onClose={() => void pg.close(row.sessionId)}
                    />
                ))}
                {state.rows.length > 1 && (
                    <label class="compare-toggle">
                        <input type="checkbox" checked={state.compare} onChange={(e) => (state.compare = (e.currentTarget as HTMLInputElement).checked)} />
                        <span>Show all side by side</span>
                    </label>
                )}
                {state.catalog && (
                    <NewSession
                        agents={state.catalog.agents}
                        defaults={state.catalog.defaults}
                        full={state.rows.length >= state.catalog.maxSessions}
                        onOpen={(agent, model, cwd) => void pg.open({ agent, ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) })}
                    />
                )}
                {state.error && <p class="error">{state.error}</p>}
            </aside>
            <section class="panes">
                {!state.ready && <p class="hint">Connecting…</p>}
                {state.rows.map((row) => (
                    <div class="pane" key={row.sessionId} hidden={!state.compare && row.sessionId !== state.selected}>
                        <Session session={pg.client(row.sessionId)!} info={row} />
                    </div>
                ))}
            </section>
        </main>
    );
});
