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
