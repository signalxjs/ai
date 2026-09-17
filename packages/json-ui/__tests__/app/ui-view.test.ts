/**
 * The renderer in the DOM (happy-dom): a spec becomes elements, streams in
 * node by node, reacts to state, dispatches actions, binds inputs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { component, defineApp, jsx, signal } from 'sigx';
import { UIView, createUIRuntime, type UIRuntime } from '../../src/app/index.js';
import { webRegistry } from '../../src/web/index.js';
import type { UISpec } from '../../src/index.js';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

function mount(node: unknown): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(node as never).mount(container);
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const registry = webRegistry();

const todo: UISpec = {
    version: 1,
    state: { draft: '', todos: [{ id: 'a', title: 'first', done: false }] },
    computed: { remaining: { $: 'count(todos, !it.done)' } },
    actions: { add: [{ do: 'state.push', path: 'todos', value: { $: '{ id: uid(), title: draft, done: false }' } }, { do: 'state.set', path: 'draft', value: '' }] },
    root: {
        type: 'stack',
        children: [
            { type: 'text', props: { text: '{{remaining}} left', variant: 'heading' } },
            { type: 'input', bind: 'draft', props: { placeholder: 'Todo' }, on: { submit: [{ do: 'call', action: 'add' }] } },
            { type: 'button', props: { label: 'Add', disabled: { $: 'draft == ""' } }, on: { press: [{ do: 'call', action: 'add' }] } },
            { type: 'list', for: { items: { $: 'todos' }, as: 'todo', key: { $: 'todo.id' } }, children: [{ type: 'text', props: { text: '{{todo.title}}', class: 'todo' }, on: { press: [{ do: 'state.toggle', path: 'todo.done' }] } }] },
            { type: 'text', if: { $: 'todos.length == 0' }, props: { text: 'Nothing yet' } }
        ]
    }
};

describe('UIView', () => {
    it('renders a spec with the web pack', () => {
        const el = mount(jsx(UIView, { spec: todo, registry }));
        expect(el.querySelector('h2')?.textContent).toBe('1 left');
        expect(el.querySelector('button')?.textContent).toBe('Add');
        expect(el.querySelector('button')?.disabled).toBe(true);
        expect(el.querySelectorAll('.todo')).toHaveLength(1);
        expect(el.textContent).not.toContain('Nothing yet');
    });

    it('actions mutate state, computed values follow, lists re-render, bind is two-way', async () => {
        let runtime!: UIRuntime;
        const el = mount(jsx(UIView, { spec: todo, registry, onRuntime: (r: UIRuntime) => (runtime = r) }));
        const input = el.querySelector('input')!;
        input.value = 'second';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect(runtime.state.draft).toBe('second');
        expect(el.querySelector('button')?.disabled).toBe(false);
        el.querySelector('button')!.click();
        await tick();
        expect((runtime.state.todos as unknown[]).length).toBe(2);
        expect(el.querySelectorAll('.todo')).toHaveLength(2);
        expect(el.querySelector('h2')?.textContent).toBe('2 left');
        expect(input.value).toBe('');
        (el.querySelectorAll('.todo')[0] as HTMLElement).click();
        await tick();
        expect(el.querySelector('h2')?.textContent).toBe('1 left');
        // Enter submits
        input.value = 'third';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await tick();
        expect(el.querySelectorAll('.todo')).toHaveLength(3);
    });

    it('appears as it streams: each new partial spec object grows the DOM without remounting earlier nodes', async () => {
        const source = signal({ spec: { root: { type: 'stack', children: [{ type: 'text', props: { text: 'He' } }] } } as UISpec, done: false });
        const View = component(() => () => jsx(UIView, { spec: source.spec, done: source.done, registry }));
        const el = mount(jsx(View, {}));
        const first = el.querySelector('span');
        expect(first?.textContent).toBe('He');
        source.spec = { root: { type: 'stack', children: [{ type: 'text', props: { text: 'Hello' } }, { type: 'butt' }] } };
        await tick();
        expect(el.querySelector('span')).toBe(first);
        expect(el.querySelector('span')?.textContent).toBe('Hello');
        expect(el.querySelector('button')).toBeNull();
        source.spec = { root: { type: 'stack', children: [{ type: 'text', props: { text: 'Hello' } }, { type: 'button', props: { label: 'Go' } }] } };
        await tick();
        expect(el.querySelector('span')).toBe(first);
        expect(el.querySelector('button')?.textContent).toBe('Go');
        source.done = true;
        await tick();
    });

    it('a late state block does not clobber what the user typed; unknown types render nothing', async () => {
        let runtime!: UIRuntime;
        const source = signal({ spec: { root: { type: 'input', bind: 'draft' } } as UISpec });
        const View = component(() => () => jsx(UIView, { spec: source.spec, done: false, registry, onRuntime: (r: UIRuntime) => (runtime = r) }));
        const el = mount(jsx(View, {}));
        const input = el.querySelector('input')!;
        input.value = 'typed';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        source.spec = { state: { draft: 'from-model', other: 1 }, root: { type: 'input', bind: 'draft' } };
        await tick();
        expect(runtime.state.draft).toBe('typed');
        expect(runtime.state.other).toBe(1);
        expect(input.value).toBe('typed');
    });

    it('emit reaches the host, action errors reach onActionError, unmount aborts a running action', async () => {
        const emitted: unknown[] = [];
        const errors: string[] = [];
        let runtime!: UIRuntime;
        const spec: UISpec = {
            state: { n: 0 },
            root: {
                type: 'stack',
                children: [
                    { type: 'button', props: { label: 'Send' }, on: { press: [{ do: 'emit', name: 'send', payload: { text: 'hi {{n}}' } }] } },
                    { type: 'button', props: { label: 'Fail' }, on: { press: [{ do: 'nope' }] } },
                    { type: 'button', props: { label: 'Slow' }, on: { press: [{ do: 'delay', ms: 30 }, { do: 'state.set', path: 'n', value: 1 }] } }
                ]
            }
        };
        const el = mount(jsx(UIView, { spec, registry, onEmit: (n: string, p: unknown) => emitted.push([n, p]), onActionError: (e: Error) => errors.push(e.message), onRuntime: (r: UIRuntime) => (runtime = r) }));
        const [send, fail, slow] = Array.from(el.querySelectorAll('button'));
        send!.click();
        fail!.click();
        await tick();
        expect(emitted).toEqual([['send', { text: 'hi 0' }]]);
        expect(errors).toEqual(['unknown action "nope"']);
        slow!.click();
        await tick();
        expect(slow!.disabled).toBe(true); // pending
        closers.splice(0).reverse().forEach((c) => c());
        await new Promise((r) => setTimeout(r, 50));
        expect(runtime.state.n).toBe(0);
    });

    it('drop mode ignores a second press while the first runs; restart aborts the first', async () => {
        const runtime = createUIRuntime({ actions: { slow: (_a, ctx) => new Promise((res, rej) => { const t = setTimeout(() => res(1), 20); ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); }) } });
        runtime.apply({ type: 'spec', spec: { state: { hits: 0 }, root: { type: 'stack', children: [
            { type: 'button', props: { label: 'A' }, on: { press: [{ do: 'slow' }, { do: 'state.set', path: 'hits', value: { $: 'hits + 1' } }] } },
            { type: 'button', props: { label: 'B' }, on: { press: { mode: 'restart', steps: [{ do: 'slow' }, { do: 'state.set', path: 'hits', value: { $: 'hits + 10' } }] } } }
        ] } } });
        runtime.apply({ type: 'finish' });
        const el = mount(jsx(UIView, { runtime, registry }));
        const [a, b] = Array.from(el.querySelectorAll('button'));
        a!.click();
        a!.click();
        b!.click();
        b!.click();
        await new Promise((r) => setTimeout(r, 60));
        expect(runtime.state.hits).toBe(11);
    });

    it('a plain runtime can be driven with text chunks and rendered', async () => {
        const runtime = createUIRuntime();
        const el = mount(jsx(UIView, { runtime, registry, placeholder: jsx('i', { children: 'thinking' }) }));
        expect(el.querySelector('i')?.textContent).toBe('thinking');
        const json = JSON.stringify({ root: { type: 'card', props: { title: 'T' }, children: [{ type: 'divider' }] } });
        for (let i = 0; i < json.length; i += 9) runtime.apply({ type: 'text', delta: json.slice(i, i + 9) });
        await tick();
        expect(el.querySelector('.json-ui-card__title')?.textContent).toBe('T');
        expect(el.querySelector('hr')).not.toBeNull();
        runtime.apply({ type: 'finish' });
        expect(runtime.doc.status).toBe('done');
        expect(runtime.doc.issues).toEqual([]);
    });
});
