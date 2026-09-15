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
 *
 * One pane shows at a time (unless *Show all side by side* is on) — and that
 * includes the session that does not exist yet: a click on New session
 * selects a "Creating session…" pane at once, because a harness can take ten
 * seconds to start and the previous conversation staying on screen reads as
 * the click having done nothing.
 */
import { component, useHead, onMounted, onUnmounted, signal } from 'sigx';
import { Session } from './Session';
import { createPlayground, OPENING, type Playground } from './sessions';
import { modeOf, openedAt, type AgentChoice, type CatalogEntry, type OpenRequest } from './catalog';

/** One row in the sidebar: what it is, what it is doing, and how to close it (none for a session that does not exist yet). */
const SessionRow = component<{
    label: string;
    model: string | undefined;
    mode: string | undefined;
    state: string;
    /** When it was opened; a pending row has none yet. */
    opened?: string;
    selected: boolean;
    onSelect: () => void;
    onClose?: () => void;
}>((ctx) => {
    return () => (
        <div class={`session-row ${ctx.props.selected ? 'selected' : ''} ${ctx.props.state}`}>
            <button type="button" class="session-pick" onClick={ctx.props.onSelect}>
                <span class="session-name">{ctx.props.label}</span>
                <span class="session-meta">
                    {[ctx.props.model, ctx.props.mode, ctx.props.state, ctx.props.opened].filter(Boolean).join(' · ')}
                </span>
            </button>
            {ctx.props.onClose && (
                <button type="button" class="session-close" aria-label="Close session" onClick={ctx.props.onClose}>
                    ×
                </button>
            )}
        </div>
    );
});

/**
 * Open another one. An agent that failed last time is offered greyed out with
 * the reason on it, rather than hidden — you should be able to see that Codex
 * is installed-but-not-signed-in without guessing why it vanished.
 */
export const NewSession = component<{
    agents: readonly CatalogEntry[];
    defaults: { agent: AgentChoice; model?: string; cwd: string };
    full: boolean;
    /** A session is being created: one at a time, so the whole form waits. */
    busy: boolean;
    onOpen: (agent: AgentChoice, model: string | undefined, cwd: string | undefined) => void;
}>((ctx) => {
    /**
     * The model to start an agent on — the catalogue default only when that
     * agent actually offers it.
     *
     * The dropdown is rendered from the agent's list and a `<select>` whose
     * `selected` matches nothing still paints its FIRST option, so a default
     * belonging to another agent left the page showing one model and the wire
     * carrying another. `undefined` for an agent with no list at all: a
     * harness reports its own once it is up, and there is nothing honest to
     * send before that.
     */
    const modelFor = (agent: AgentChoice): string | undefined => {
        const models = ctx.props.agents.find((a) => a.id === agent)?.models ?? [];
        if (models.length === 0) return undefined;
        const wanted = ctx.props.defaults.model;
        return models.some((m) => m.id === wanted) ? wanted : models[0]!.id;
    };

    // Reactive, not plain `let`s: the Model dropdown and the Directory field
    // are rendered FROM the chosen agent, so a non-reactive draft left them
    // showing the previous agent's — a harness never got its cwd field.
    const draft = signal<{ agent: AgentChoice; model: string | undefined; cwd: string }>({
        agent: ctx.props.defaults.agent,
        model: modelFor(ctx.props.defaults.agent),
        cwd: ctx.props.defaults.cwd
    });
    const entry = () => ctx.props.agents.find((a) => a.id === draft.agent);

    function submit(e: Event): void {
        e.preventDefault();
        // The fieldset is disabled meanwhile, but `requestSubmit()` is not.
        if (ctx.props.busy) return;
        ctx.props.onOpen(draft.agent, draft.model, entry()?.needsCwd ? draft.cwd : undefined);
    }

    // One `disabled` for the whole form: the selects too, so nothing suggests
    // a change made now reaches the request already under way.
    return () => (
        <form class="new-session" onSubmit={submit}>
            <fieldset disabled={ctx.props.busy}>
            <label>
                <span>Agent</span>
                <select
                    onChange={(e) => {
                        const next = (e.currentTarget as HTMLSelectElement).value as AgentChoice;
                        draft.agent = next;
                        // The model has to belong to the new agent, or the
                        // session opens on one it does not offer.
                        draft.model = modelFor(next);
                    }}
                >
                    {ctx.props.agents.map((a) => (
                        <option value={a.id} selected={a.id === draft.agent} disabled={Boolean(a.unavailable)} title={a.unavailable ?? a.install}>
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
                    <select onChange={(e) => (draft.model = (e.currentTarget as HTMLSelectElement).value)}>
                        {entry()!.models.map((m) => (
                            <option value={m.id} selected={m.id === draft.model}>
                                {m.label ?? m.id}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {entry()?.needsCwd && (
                <label>
                    <span>Directory</span>
                    <input type="text" value={draft.cwd} onInput={(e) => (draft.cwd = (e.currentTarget as HTMLInputElement).value)} />
                </label>
            )}
            <button type="submit" disabled={ctx.props.full}>
                {ctx.props.busy ? 'Creating session…' : 'New session'}
            </button>
            {ctx.props.full && <p class="hint">The session limit is reached — close one first.</p>}
            </fieldset>
        </form>
    );
});

/** The pane a session has until the server answers: what was asked for, and that it is on its way. */
const OpeningPane = component<{ label: string; request: OpenRequest }>((ctx) => {
    return () => (
        <div class="opening">
            <header>
                <h1>
                    {ctx.props.label}
                    {ctx.props.request.model ? <small class="model"> {ctx.props.request.model}</small> : null}
                </h1>
                <small>opening</small>
            </header>
            <p class="hint" role="status">
                Creating session… A harness starts its own process first, which can take a while.
            </p>
        </div>
    );
});

/**
 * The shell, over a playground it is handed. `App` builds the real one; a
 * test builds one on scripted endpoints and mounts this.
 */
export const Shell = component<{ pg: Playground }>((ctx) => {
    const pg = ctx.props.pg;
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
                        key={row.sessionId}
                        label={label(row.agent)}
                        model={row.model}
                        mode={modeOf(row.config)}
                        state={row.state}
                        opened={openedAt(row.createdAt)}
                        selected={row.sessionId === state.selected}
                        onSelect={() => pg.select(row.sessionId)}
                        onClose={() => void pg.close(row.sessionId)}
                    />
                ))}
                {state.opening && (
                    <SessionRow
                        label={label(state.opening.agent)}
                        model={state.opening.model}
                        mode={undefined}
                        state="opening"
                        selected={state.selected === OPENING}
                        onSelect={() => pg.select(OPENING)}
                    />
                )}
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
                        busy={state.opening !== undefined}
                        onOpen={(agent, model, cwd) => void pg.open({ agent, ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) })}
                    />
                )}
                {state.error && <p class="error">{state.error}</p>}
            </aside>
            <section class="panes">
                {!state.ready && <p class="hint">Connecting…</p>}
                {state.rows.map((row) => (
                    <div class="pane" key={`session:${row.sessionId}`} hidden={!state.compare && row.sessionId !== state.selected}>
                        <Session session={pg.client(row.sessionId)!} info={row} />
                    </div>
                ))}
                {state.opening && (
                    <div class="pane" key="opening" hidden={!state.compare && state.selected !== OPENING}>
                        <OpeningPane label={label(state.opening.agent)} request={state.opening} />
                    </div>
                )}
            </section>
        </main>
    );
});

export const App = component(() => {
    useHead({ title: 'sigx ai — agent playground' });
    const pg = createPlayground();
    return () => <Shell pg={pg} />;
});
