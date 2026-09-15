/**
 * The browser's session store, against real `serveSession` / `connectSession`
 * over an in-memory registry.
 *
 * This is the half the smoke test cannot see (it drives the server only) and
 * the DOM test does not reach (it mounts single components). Opening a session
 * and having it appear is the playground's whole premise, so it gets a test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, jsx, defineApp } from 'sigx';
import { mockAgent } from '@sigx/ai-agent/testing';
import { memoryEventLog, type AgentSession } from '@sigx/ai-agent';
import { serveSession, isWireCommand, WIRE_PROTOCOL_VERSION, type ServedSession, type WireCommand } from '@sigx/ai-agent/wire';
import type { AgentCatalog, AgentChoice, CatalogEntry, OpenRequest, OpenResult, SessionInfo } from '../src/catalog';

/** A registry the size of the test: `mockAgent` sessions, served for real. */
const sessions = new Map<string, { session: AgentSession; served: ServedSession; info: SessionInfo }>();
const eventLog = memoryEventLog();

const CATALOG: AgentCatalog = {
    agents: [
        { id: 'mock', label: 'mock (scripted)', kind: 'mock', models: [], needsCwd: false },
        { id: 'sigx', label: 'sigx (our engine)', kind: 'engine', models: [{ id: 'mock:demo' }], needsCwd: false },
        { id: 'claude-code', label: 'Claude Code', kind: 'harness', models: [], needsCwd: true }
    ],
    defaults: { agent: 'mock', cwd: '/tmp' },
    maxSessions: 4
};

/** Set to a message to make the next open reject, the way a dead CLI does. */
let failNextOpen: string | undefined;

async function openOne(request: OpenRequest): Promise<OpenResult> {
    if (failNextOpen !== undefined) {
        const reason = failNextOpen;
        failNextOpen = undefined;
        throw new Error(reason);
    }
    const agent = mockAgent({ id: request.agent, script: [[{ text: `hello from ${request.agent}` }]] });
    const session = await agent.session({});
    const info: SessionInfo = {
        sessionId: session.id,
        agent: request.agent,
        agentId: agent.id,
        ...(request.model ? { model: request.model } : {}),
        capabilities: agent.capabilities,
        config: [],
        state: 'idle',
        createdAt: Date.now()
    };
    sessions.set(session.id, { session, served: serveSession(session, { agentId: agent.id, capabilities: agent.capabilities, eventLog }), info });
    return { ok: true, session: info };
}

vi.mock('../src/agent.server', () => ({
    agentCatalog: () => Promise.resolve(CATALOG),
    agentSessions: () => Promise.resolve([...sessions.values()].map((s) => s.info)),
    agentOpenSession: (request: OpenRequest) => openOne(request),
    agentCommand: ({ sessionId, command }: { sessionId: string; command: unknown }) => {
        const target = sessions.get(sessionId);
        if (!target) return Promise.resolve({ v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: '', code: 'closed', message: 'no session' });
        if (!isWireCommand(command)) throw new Error('not a wire command');
        return target.served.handleCommand(command as WireCommand);
    },
    agentEvents: ({ sessionId, from }: { sessionId: string; from?: { epoch: number; seq: number } }) => {
        const target = sessions.get(sessionId);
        if (!target) throw new Error('no session');
        return target.served.events(from);
    }
}));

const { createPlayground } = await import('../src/sessions');

afterEach(async () => {
    for (const { session } of sessions.values()) await session.close().catch(() => {});
    sessions.clear();
});

describe('the playground store', () => {
    it('shows a session the moment it is opened — no reload', async () => {
        const pg = createPlayground();
        await pg.refresh();
        expect(pg.state.rows).toHaveLength(0);

        await pg.open({ agent: 'mock' });

        // The bug this exists for: the row was only there after a reload,
        // because `refresh()` re-read the server list while `open()` did not
        // put it on screen.
        expect(pg.state.rows).toHaveLength(1);
        expect(pg.state.rows[0]!.agent).toBe('mock');
        expect(pg.state.selected).toBe(pg.state.rows[0]!.sessionId);
        expect(pg.client(pg.state.rows[0]!.sessionId)).toBeDefined();
        pg.disconnectAll();
    });

    it('keeps each session, and selects the newest', async () => {
        const pg = createPlayground();
        await pg.refresh();
        await pg.open({ agent: 'mock' });
        const first = pg.state.selected;
        await pg.open({ agent: 'sigx' });

        expect(pg.state.rows).toHaveLength(2);
        expect(pg.state.rows.map((r) => r.agent)).toEqual(['mock', 'sigx']);
        expect(pg.state.selected).not.toBe(first);
        // Both clients stay live: switching is a selection, not a reconnect.
        expect(pg.state.rows.every((r) => pg.client(r.sessionId) !== undefined)).toBe(true);
        pg.disconnectAll();
    });

    it('select() moves the selection to an open session', async () => {
        const pg = createPlayground();
        await pg.refresh();
        await pg.open({ agent: 'mock' });
        const first = pg.state.rows[0]!.sessionId;
        await pg.open({ agent: 'sigx' });

        pg.select(first);
        expect(pg.state.selected).toBe(first);
        pg.disconnectAll();
    });
});

describe('the playground view', () => {
    const closers: (() => void)[] = [];
    afterEach(() => {
        for (const close of closers.splice(0).reverse()) close();
    });
    const tick = (n = 4) => new Promise((r) => setTimeout(r, n));

    async function mountApp() {
        const { App } = await import('../src/App');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(jsx(App, {})).mount(container);
        closers.push(() => {
            app.unmount();
            container.remove();
        });
        await tick(30);
        return container;
    }

    it('renders a row and a visible pane per session, and hides the rest', async () => {
        const dom = await mountApp();
        // The auto-open on mount gives us one.
        expect(dom.querySelectorAll('.session-row')).toHaveLength(1);
        const panes = () => [...dom.querySelectorAll<HTMLElement>('.pane')];
        expect(panes()).toHaveLength(1);
        expect(panes()[0]!.hidden).toBe(false);
    });

    it('a new session appears at once, and its pane is the visible one', async () => {
        const dom = await mountApp();
        dom.querySelector('form.new-session')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick(30);

        // Reported: the row only showed up after a reload.
        expect(dom.querySelectorAll('.session-row')).toHaveLength(2);
        const panes = [...dom.querySelectorAll<HTMLElement>('.pane')];
        expect(panes).toHaveLength(2);
        // Reported: the previous session stayed on screen.
        expect(panes.map((p) => p.hidden)).toEqual([true, false]);
    });

    it('the form follows the agent: picking a harness reveals its directory field', async () => {
        const dom = await mountApp();
        const agentSelect = dom.querySelector<HTMLSelectElement>('.new-session select')!;
        expect(dom.querySelector('.new-session input[type=text]')).toBeNull(); // mock needs no cwd

        agentSelect.value = 'claude-code';
        agentSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await tick(20);

        // The draft used to be a plain `let`, so this field never appeared and
        // a harness opened on whatever cwd the server defaulted to.
        expect(dom.querySelector('.new-session input[type=text]')).not.toBeNull();
    });

    it('surfaces a failure to open instead of doing nothing', async () => {
        const dom = await mountApp();
        // Fail the NEXT open, not the auto-open on mount.
        failNextOpen = 'the CLI is not installed';
        dom.querySelector('form.new-session')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick(30);

        // Reported as "nothing happens": a rejection used to vanish into the
        // `void` at the call site, leaving the page exactly as it was.
        expect(dom.querySelector('.sidebar .error')?.textContent).toContain('not installed');
        expect(dom.querySelectorAll('.session-row')).toHaveLength(1);
    });

    it('clicking a row switches which pane is visible', async () => {
        const dom = await mountApp();
        dom.querySelector('form.new-session')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick(30);

        // Reported: clicking the other session did nothing.
        dom.querySelectorAll<HTMLElement>('.session-pick')[0]!.click();
        await tick(30);
        expect([...dom.querySelectorAll<HTMLElement>('.pane')].map((p) => p.hidden)).toEqual([false, true]);
    });
});

/**
 * The same thing again, but HYDRATED — which is how the example actually
 * runs. `entry-client.tsx` adopts the server's markup instead of rendering
 * over it, and the server renders with no sessions (`onMounted` does not run
 * there), so the list the browser mutates is a list hydration adopted.
 */
describe('the playground view, hydrated', () => {
    const closers: (() => void)[] = [];
    afterEach(() => {
        for (const close of closers.splice(0).reverse()) close();
    });
    const tick = (n = 30) => new Promise((r) => setTimeout(r, n));

    it('a new session appears and its pane becomes the visible one', async () => {
        const { App } = await import('../src/App');
        const { renderToString } = await import('@sigx/server-renderer');
        const { hydrate } = await import('@sigx/server-renderer/client');

        const html = await renderToString(defineApp(jsx(App, {})));
        const container = document.createElement('div');
        container.innerHTML = typeof html === 'string' ? html : String(html);
        document.body.appendChild(container);
        const app = defineApp(jsx(App, {})).mount(container, hydrate);
        closers.push(() => {
            app.unmount();
            container.remove();
        });
        await tick();

        expect(container.querySelectorAll('.session-row')).toHaveLength(1);
        container.querySelector('form.new-session')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();

        expect(container.querySelectorAll('.session-row')).toHaveLength(2);
        expect([...container.querySelectorAll<HTMLElement>('.pane')].map((p) => p.hidden)).toEqual([true, false]);
    });
});

/**
 * The shell's CSS, read as text.
 *
 * Not pedantry: `hidden` is what switches panes, and the UA stylesheet's
 * `[hidden] { display: none }` is the LOWEST-priority rule there is. Any
 * `display` on `.pane` beats it, and the pane stays on screen — every session
 * stacking down the page, with the first one always the one you see. No DOM
 * test can catch that, because happy-dom runs no cascade: `el.hidden` is
 * perfectly `true` while a real browser shows the element.
 */
describe('the shell stylesheet', () => {
    it('neutralises display on a hidden pane', async () => {
        const { readFile } = await import('node:fs/promises');
        // A path, not `import.meta.url`: under happy-dom that is an http URL.
        const html = await readFile('examples/agent/index.html', 'utf8');
        const setsDisplay = /\.pane\s*\{[^}]*\bdisplay\s*:/.test(html);
        if (setsDisplay) {
            expect(html).toMatch(/\.pane\[hidden\]\s*\{[^}]*display\s*:\s*none/);
        }
    });
});

/**
 * The New-session form on its own.
 *
 * One contract: **what the form submits is what the form is showing.** The
 * Model dropdown is rendered from the chosen agent's list, but the draft was
 * seeded from the catalogue's default — and a `<select>` whose `selected`
 * matches no option still paints its FIRST one. So a default belonging to
 * another agent (or to none) left the page showing one model and the wire
 * carrying another.
 */
describe('the New-session form', () => {
    const closers: (() => void)[] = [];
    afterEach(() => {
        for (const close of closers.splice(0).reverse()) close();
    });

    const AGENTS: readonly CatalogEntry[] = [
        { id: 'mock', label: 'mock (scripted)', kind: 'mock', models: [], needsCwd: false },
        { id: 'sigx', label: 'sigx (our engine)', kind: 'engine', models: [{ id: 'mock:demo' }, { id: 'mock:other' }], needsCwd: false },
        { id: 'claude-code', label: 'Claude Code', kind: 'harness', models: [], needsCwd: true }
    ];

    type Opened = { agent: AgentChoice; model: string | undefined; cwd: string | undefined };

    async function form(defaults: { agent: AgentChoice; model?: string; cwd: string }) {
        const { NewSession } = await import('../src/App');
        const opened: Opened[] = [];
        const One = component(
            () => () => <NewSession agents={AGENTS} defaults={defaults} full={false} busy={false} onOpen={(agent, model, cwd) => opened.push({ agent, model, cwd })} />,
            { name: 'One' }
        );
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(jsx(One, {})).mount(container);
        closers.push(() => {
            app.unmount();
            container.remove();
        });
        const submit = () => container.querySelector('form.new-session')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        const modelSelect = () => [...container.querySelectorAll<HTMLSelectElement>('select')][1];
        const agentSelect = () => container.querySelector<HTMLSelectElement>('select')!;
        return { container, opened, submit, modelSelect, agentSelect };
    }

    it('submits the model the dropdown is showing, not a stale default', async () => {
        // `gone:old` is no model of any agent — the catalogue moved on.
        const f = await form({ agent: 'sigx', model: 'gone:old', cwd: '/tmp' });

        // What the browser paints when nothing matches: the first option.
        expect(f.modelSelect()!.value).toBe('mock:demo');
        f.submit();

        expect(f.opened).toHaveLength(1);
        expect(f.opened[0]!.model).toBe('mock:demo');
    });

    it('sends no model for an agent that offers none', async () => {
        // A harness reports its models once it is up, so the form shows no
        // dropdown — submitting the catalogue default would name a model this
        // agent never offered.
        const f = await form({ agent: 'mock', model: 'mock:demo', cwd: '/tmp' });

        expect(f.modelSelect()).toBeUndefined();
        f.submit();

        expect(f.opened[0]!.model).toBeUndefined();
    });

    it('keeps a default the newly-picked agent does offer', async () => {
        const f = await form({ agent: 'mock', model: 'mock:other', cwd: '/tmp' });

        f.agentSelect().value = 'sigx';
        f.agentSelect().dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));

        // Not `mock:demo`: jumping to the first model throws away a perfectly
        // good default the new agent lists.
        expect(f.modelSelect()!.value).toBe('mock:other');
        f.submit();
        expect(f.opened[0]!.model).toBe('mock:other');
    });
});
