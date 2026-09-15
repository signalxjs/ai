/**
 * The agent example's view, in the DOM.
 *
 * These are rendering decisions, and they live nowhere else: no package test
 * can see that a tool which returned an empty string draws a padded grey
 * rectangle (#128), because the packages have no view. So mount the real
 * `Part` and look at the elements it produced.
 *
 * The rule the whole file checks is one rule: **a block element is opened for
 * content that exists, never for content that is merely present**. An output
 * of `''`, a summary of `'   '`, an error with no message — each of them used
 * to open a box around nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { component, jsx, defineApp } from 'sigx';
import { createTranscript, type AgentState, type AgentPart, type AgentTranscript, type ConfigOption, type ToolPartState } from '@sigx/ai-agent';

// No `vi.mock` and no dynamic import: `Thread.tsx` imports nothing from the
// server module, and the server module no longer opens a session at import
// either. Both used to be necessary.
import { ConfigPanel } from '../src/Session';
import { Part } from '../src/Thread';
import { Shell } from '../src/App';
import { createPlayground, type Playground, type PlaygroundApi } from '../src/sessions';
import type { AgentCatalog, OpenRequest, OpenResult, SessionInfo } from '../src/catalog';
import { mockAgent } from '@sigx/ai-agent/testing';
import { serveSession, type ServedSession } from '@sigx/ai-agent/wire';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** Mount one part and hand back the DOM it produced. */
function render(part: AgentPart, transcript: AgentTranscript = createTranscript('s1')): HTMLDivElement {
    const One = component(() => () => <Part part={part} transcript={transcript} requests={[]} onDecide={() => {}} onAnswer={() => {}} />, { name: 'One' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(jsx(One, {})).mount(container);
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

const tool = (p: Partial<ToolPartState> = {}): ToolPartState => ({ type: 'tool', callId: 'c1', name: 'ToolSearch', status: 'completed', input: { query: 'select:Read' }, ...p });

/** A sub-agent card, reached the way the app reaches it: the call that spawned it. */
function withAgent(agent: Partial<AgentState>): { part: AgentPart; transcript: AgentTranscript } {
    const transcript = createTranscript('s1');
    const full: AgentState = { agentId: 'a1', callId: 'c1', depth: 1, seq: 1, status: 'completed', title: 'Triage', ...agent };
    transcript.agents[full.agentId] = full;
    return { part: tool({ agentId: full.agentId }), transcript };
}

describe('tool output', () => {
    it('opens no <pre> for a call that completed with an EMPTY output (#128)', () => {
        const dom = render(tool({ output: '' }));
        expect(dom.querySelector('pre.tool-output')).toBeNull();
        // It ran and gave nothing back — that is worth one dim word, so it
        // still reads differently from a call that has not returned yet.
        expect(dom.querySelector('.tool-empty')?.textContent).toBe('no output');
    });

    it('opens no <pre> for an output that is only whitespace', () => {
        const dom = render(tool({ output: '  \n\t ' }));
        expect(dom.querySelector('pre.tool-output')).toBeNull();
        expect(dom.querySelector('.tool-empty')).not.toBeNull();
    });

    it('opens no <pre> for content blocks that flatten to nothing', () => {
        const dom = render(tool({ content: [{ type: 'text', text: '' }] }));
        expect(dom.querySelector('pre.tool-output')).toBeNull();
        expect(dom.querySelector('.tool-empty')).not.toBeNull();
    });

    it('still renders a real output', () => {
        const dom = render(tool({ output: '[{"id":"INC-41"}]' }));
        expect(dom.querySelector('pre.tool-output')?.textContent).toBe('[{"id":"INC-41"}]');
        expect(dom.querySelector('.tool-empty')).toBeNull();
    });

    it('renders a non-string output as JSON, not as an empty box', () => {
        const dom = render(tool({ output: [{ id: 'INC-41' }] }));
        expect(dom.querySelector('pre.tool-output')?.textContent).toContain('"INC-41"');
    });

    // Absent is not empty: a call still running, an empty `content` array, or a
    // harness that reports no outputs at all must say nothing whatsoever.
    it.each([
        ['still running', tool({ status: 'in_progress', output: undefined })],
        ['an empty content array', tool({ content: [] })],
        ['completed with nothing reported', tool({ output: undefined })]
    ])('says nothing at all when the output is absent — %s', (_name, part) => {
        const dom = render(part);
        expect(dom.querySelector('pre.tool-output')).toBeNull();
        expect(dom.querySelector('.tool-empty')).toBeNull();
    });
});

describe('tool error', () => {
    it('opens no element for an error with an empty message', () => {
        const dom = render(tool({ status: 'failed', error: '   ' }));
        expect(dom.querySelector('.tool-error')).toBeNull();
        // The card still says what happened.
        expect(dom.querySelector('.tool-status')?.textContent).toBe('failed');
    });

    it('still renders a real error', () => {
        const dom = render(tool({ status: 'failed', error: 'boom' }));
        expect(dom.querySelector('.tool-error')?.textContent).toBe('boom');
    });
});

describe('sub-agent card', () => {
    it('opens no <p> for a summary that is only whitespace', () => {
        const { part, transcript } = withAgent({ summary: '   ' });
        const dom = render(part, transcript);
        expect(dom.querySelector('.agent')).not.toBeNull();
        expect(dom.querySelector('p.agent-summary')).toBeNull();
    });

    it('still renders a real summary, on one line', () => {
        const { part, transcript } = withAgent({ summary: 'INC-41  first\nthen INC-42' });
        const dom = render(part, transcript);
        expect(dom.querySelector('p.agent-summary')?.textContent).toBe('INC-41 first then INC-42');
    });

    it('opens no element for an error with an empty message', () => {
        const { part, transcript } = withAgent({ status: 'failed', error: { code: 'provider_error', message: '' } });
        const dom = render(part, transcript);
        expect(dom.querySelector('.agent .tool-error')).toBeNull();
        expect(dom.querySelector('.agent-status')?.textContent).toBe('failed');
    });

    it('still renders a real error', () => {
        const { part, transcript } = withAgent({ status: 'failed', error: { code: 'provider_error', message: 'the delegate gave up' } });
        const dom = render(part, transcript);
        expect(dom.querySelector('.agent .tool-error')?.textContent).toBe('the delegate gave up');
    });
});

describe('reasoning', () => {
    it('opens no <details> for thinking text that is only whitespace', () => {
        const dom = render({ type: 'reasoning', id: 'r1', text: '  ' });
        expect(dom.querySelector('details.reasoning')).toBeNull();
        // Still thinking, so the live indicator stays (#78).
        expect(dom.querySelector('.reasoning.thinking')).not.toBeNull();
    });

    it('still renders real thinking', () => {
        const dom = render({ type: 'reasoning', id: 'r1', text: 'weighing INC-41', done: true });
        expect(dom.querySelector('details.reasoning')?.textContent).toContain('weighing INC-41');
    });
});

/**
 * The settings panel. It is the whole payoff of the `config` event — plan mode
 * on Claude Code, `mode` on an ACP agent, sandbox on Codex and the model
 * everywhere, all out of one loop with no per-adapter branching — so what it
 * does with an empty, an unsupported and a single-valued option is the part
 * worth pinning.
 */
describe('config panel', () => {
    function panel(options: ConfigOption[], supported = true, onChange: (id: string, value: string) => void = () => {}): HTMLDivElement {
        const One = component(() => () => <ConfigPanel options={options} supported={supported} onChange={onChange} />, { name: 'One' });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(jsx(One, {})).mount(container);
        closers.push(() => {
            app.unmount();
            container.remove();
        });
        return container;
    }

    const mode: ConfigOption = {
        id: 'permissionMode',
        label: 'Permission mode',
        values: [{ id: 'default' }, { id: 'plan', label: 'Plan' }, { id: 'acceptEdits' }],
        current: 'plan'
    };

    it('renders one select per option, with the current value selected', () => {
        const dom = panel([mode, { id: 'model', label: 'Model', values: [{ id: 'a' }, { id: 'b' }], current: 'b' }]);
        const selects = [...dom.querySelectorAll('select')];
        expect(selects).toHaveLength(2);
        expect([...selects[0]!.options].map((o) => o.value)).toEqual(['default', 'plan', 'acceptEdits']);
        expect(selects[0]!.value).toBe('plan');
        expect(selects[1]!.value).toBe('b');
    });

    it('reports a change as (id, value) — the patch `configure()` takes', () => {
        const seen: [string, string][] = [];
        const dom = panel([mode], true, (id, value) => seen.push([id, value]));
        const select = dom.querySelector('select')!;
        select.value = 'default';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(seen).toEqual([['permissionMode', 'default']]);
    });

    it('an option with one value is shown, not offered — a dropdown of one is a lie', () => {
        const dom = panel([{ id: 'model', label: 'Model', values: [{ id: 'claude-opus-5' }], current: 'claude-opus-5' }]);
        const select = dom.querySelector('select')!;
        expect(select.disabled).toBe(true);
        expect(select.value).toBe('claude-opus-5');
    });

    it('says the settings are coming rather than drawing an empty panel', () => {
        const dom = panel([], true);
        expect(dom.querySelector('select')).toBeNull();
        expect(dom.querySelector('.config')).toBeNull();
        expect(dom.textContent).toContain('after its first message');
    });

    it('an agent with no config capability gets no panel at all', () => {
        const dom = panel([], false);
        expect(dom.querySelector('select')).toBeNull();
        expect(dom.textContent).toContain('no live settings');
    });
});

/**
 * The shell over scripted endpoints. `open` answers when the test says so —
 * that is the 13 seconds a harness takes to start, held still — and a session
 * it answers with is a real `mockAgent` served in memory, so the pane that
 * takes the placeholder's spot is a live one.
 */
describe('the shell', () => {
    const catalog: AgentCatalog = {
        agents: [{ id: 'mock', label: 'Scripted mock', kind: 'mock', models: [{ id: 'mock-1' }, { id: 'mock-2' }], needsCwd: false }],
        defaults: { agent: 'mock', model: 'mock-1', cwd: '.' },
        maxSessions: 4
    };

    /** The pending `open()` calls, in order; a test settles them by hand. */
    let pending: { request: OpenRequest; settle: (result: OpenResult) => void }[] = [];
    let served: Map<string, ServedSession>;

    async function openMock(request: OpenRequest, sessionId: string): Promise<SessionInfo> {
        const agent = mockAgent({ id: 'mock' });
        const session = await agent.session();
        served.set(sessionId, serveSession(session, { agentId: agent.id, capabilities: agent.capabilities }));
        return { sessionId, agent: request.agent, agentId: agent.id, model: request.model, capabilities: agent.capabilities, config: [], state: 'idle', createdAt: Date.now() };
    }

    const api: PlaygroundApi = {
        catalog: async () => catalog,
        sessions: async () => [],
        open: (request) => new Promise<OpenResult>((settle) => pending.push({ request, settle })),
        command: (sessionId, command) => served.get(sessionId)!.handleCommand(command),
        events: (sessionId, from) => served.get(sessionId)!.events(from)
    };

    /** The DOM settles a tick after each server answer. */
    const tick = () => new Promise((r) => setTimeout(r, 0));

    /** Mount the shell; on mount it opens the default session, which the test then settles. */
    async function mountShell(): Promise<{ dom: HTMLDivElement; pg: Playground }> {
        pending = [];
        served = new Map();
        const pg = createPlayground(api);
        const One = component(() => () => <Shell pg={pg} />, { name: 'One' });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(jsx(One, {})).mount(container);
        closers.push(() => {
            app.unmount();
            container.remove();
            for (const s of served.values()) void s.close();
        });
        await tick();
        return { dom: container, pg };
    }

    /** Settle the oldest pending open with a live session. */
    async function arrive(sessionId: string): Promise<void> {
        const next = pending.shift()!;
        next.settle({ ok: true, session: await openMock(next.request, sessionId) });
        await tick();
        await tick();
    }

    const rows = (dom: HTMLElement) => [...dom.querySelectorAll('.session-row')];
    const visiblePanes = (dom: HTMLElement) => [...dom.querySelectorAll<HTMLElement>('.pane')].filter((p) => !p.hidden);
    /** The form's one `disabled`: the fieldset around every control. */
    const newSession = (dom: HTMLElement) => dom.querySelector<HTMLFieldSetElement>('.new-session fieldset')!;
    const clickNew = (dom: HTMLElement) => dom.querySelector('form.new-session')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const pick = (dom: HTMLElement, row: number) => rows(dom)[row]!.querySelector<HTMLButtonElement>('.session-pick')!.click();

    it('shows the session being created — a row, a pane, a disabled form — before the server has answered (#160)', async () => {
        const { dom } = await mountShell();
        // Mount opened the default session; it has not come back yet.
        expect(pending).toHaveLength(1);
        expect(rows(dom)).toHaveLength(1);
        expect(rows(dom)[0]!.classList.contains('opening')).toBe(true);
        expect(rows(dom)[0]!.classList.contains('selected')).toBe(true);
        expect(rows(dom)[0]!.querySelector('.session-close')).toBeNull();
        expect(visiblePanes(dom)).toHaveLength(1);
        expect(visiblePanes(dom)[0]!.textContent).toContain('Creating session');
        expect(visiblePanes(dom)[0]!.textContent).toContain('Scripted mock');
        expect(newSession(dom).disabled).toBe(true);
    });

    it('the pending pane becomes the live session in the same spot, and the form comes back', async () => {
        const { dom } = await mountShell();
        await arrive('s1');
        expect(pending).toHaveLength(0);
        expect(rows(dom)).toHaveLength(1);
        expect(rows(dom)[0]!.classList.contains('opening')).toBe(false);
        expect(rows(dom)[0]!.classList.contains('selected')).toBe(true);
        expect(visiblePanes(dom)).toHaveLength(1);
        expect(visiblePanes(dom)[0]!.querySelector('textarea')).not.toBeNull();
        expect(visiblePanes(dom)[0]!.textContent).not.toContain('Creating session');
        expect(newSession(dom).disabled).toBe(false);
    });

    it('a second New session hides the current conversation behind the pending pane — one pane at a time', async () => {
        const { dom } = await mountShell();
        await arrive('s1');
        clickNew(dom);
        await tick();
        expect(pending).toHaveLength(1);
        expect(rows(dom)).toHaveLength(2);
        expect(rows(dom)[1]!.classList.contains('opening')).toBe(true);
        expect(rows(dom).map((r) => r.classList.contains('selected'))).toEqual([false, true]);
        expect(visiblePanes(dom)).toHaveLength(1);
        expect(visiblePanes(dom)[0]!.textContent).toContain('Creating session');
        // The form waits — the fieldset is the one `disabled`, so its selects
        // wait with it; a double-click cannot open two.
        expect(newSession(dom).disabled).toBe(true);
        expect(dom.querySelector('.new-session select')!.closest('fieldset')).toBe(newSession(dom));
        clickNew(dom);
        await tick();
        expect(pending).toHaveLength(1);
    });

    it('an open that lands after the page has gone leaves no connection behind', async () => {
        const { dom, pg } = await mountShell();
        await arrive('s1');
        clickNew(dom);
        await tick();
        // Navigate away with the harness still starting.
        closers.splice(0).reverse().forEach((close) => close());
        expect(pg.client('s1')).toBeUndefined();
        await arrive('s2');
        // The session is on the server, as it should be; the page holds no client to it.
        expect(served.has('s2')).toBe(true);
        expect(pg.client('s2')).toBeUndefined();
        expect(pg.state.rows.map((r) => r.sessionId)).not.toContain('s2');
        // And nothing selects a session no row has.
        expect(pg.state.selected).not.toBe('s2');
    });

    it('a failed open drops the pending pane, shows the reason and goes back to the previous session', async () => {
        const { dom } = await mountShell();
        await arrive('s1');
        clickNew(dom);
        await tick();
        pending.shift()!.settle({ ok: false, reason: 'copilot: not signed in' });
        await tick();
        await tick();
        expect(rows(dom)).toHaveLength(1);
        expect(rows(dom)[0]!.classList.contains('selected')).toBe(true);
        expect(visiblePanes(dom)).toHaveLength(1);
        expect(visiblePanes(dom)[0]!.querySelector('textarea')).not.toBeNull();
        expect(dom.querySelector('.sidebar .error')?.textContent).toContain('not signed in');
        expect(newSession(dom).disabled).toBe(false);
    });

    it('an operator who moved on while a session was being created is left where they went', async () => {
        const { dom } = await mountShell();
        await arrive('s1');
        clickNew(dom);
        await tick();
        pick(dom, 0);
        await tick();
        await arrive('s2');
        expect(rows(dom).map((r) => r.classList.contains('selected'))).toEqual([true, false]);
        expect([...dom.querySelectorAll<HTMLElement>('.pane')].map((p) => p.hidden)).toEqual([false, true]);
    });

    it('clicking a sidebar row switches the visible pane', async () => {
        const { dom } = await mountShell();
        await arrive('s1');
        clickNew(dom);
        await tick();
        await arrive('s2');
        expect(rows(dom)).toHaveLength(2);
        expect(rows(dom).map((r) => r.classList.contains('selected'))).toEqual([false, true]);
        expect([...dom.querySelectorAll<HTMLElement>('.pane')].map((p) => p.hidden)).toEqual([true, false]);

        pick(dom, 0);
        await tick();
        expect(rows(dom).map((r) => r.classList.contains('selected'))).toEqual([true, false]);
        expect([...dom.querySelectorAll<HTMLElement>('.pane')].map((p) => p.hidden)).toEqual([false, true]);
        // Two sessions of one agent look the same; the pane says WHICH one it is.
        expect(visiblePanes(dom)[0]!.querySelector('header')!.textContent).toContain('opened ');

        // And while another is being created the rows still switch — to a
        // live session, and back to the pending one.
        clickNew(dom);
        await tick();
        expect(visiblePanes(dom)[0]!.textContent).toContain('Creating session');
        pick(dom, 1);
        await tick();
        expect(visiblePanes(dom)).toHaveLength(1);
        expect(visiblePanes(dom)[0]!.textContent).not.toContain('Creating session');
        pick(dom, 2);
        await tick();
        expect(visiblePanes(dom)[0]!.textContent).toContain('Creating session');
    });
});
