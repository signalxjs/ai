/**
 * The playground path, end to end and self-contained: a `render_ui` tool
 * call whose arguments arrive as small `tool-input` deltas through the
 * core's own reducer (so `part.input` is a fresh partial object per token),
 * mounted on `UIView`. Regression for two streaming bugs: a `{$}` that is
 * still `{}` must not throw, and `spec.state` must keep seeding the runtime
 * state until the stream finishes (a half-typed `todos` array was seeded
 * once and then frozen).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { component, defineApp, jsx, signal } from 'sigx';
import { applyChunk, createMessage, type UIChunk, type UIToolPart } from '@sigx/ai';
import { UIView, type UIRuntime } from '../../src/app/index.js';
import { webRegistry } from '../../src/web/index.js';
import type { UISpec } from '../../src/index.js';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});
const tick = () => new Promise((r) => setTimeout(r, 0));

const spec: UISpec = {
    version: 1,
    state: { draft: '', todos: [{ id: 'a', title: 'Try the scripted mock', done: true }, { id: 'b', title: 'Add a todo below', done: false }] },
    computed: { remaining: { $: 'count(todos, !it.done)' } },
    actions: { add: [{ do: 'state.push', path: 'todos', value: { $: '{ id: uid(), title: trim(draft), done: false }' } }, { do: 'state.set', path: 'draft', value: '' }] },
    root: {
        type: 'card',
        props: { title: 'Todos' },
        children: [
            { type: 'text', props: { text: '{{remaining}} of {{todos.length}} left', variant: 'caption' } },
            { type: 'input', bind: 'draft', props: { placeholder: 'What needs doing?' }, on: { submit: [{ do: 'call', action: 'add' }] } },
            {
                type: 'list',
                for: { items: { $: 'todos' }, as: 'todo', key: { $: 'todo.id' } },
                children: [{ type: 'text', props: { text: '{{todo.title}}', class: 'row' }, if: { $: 'todo.title != ""' }, on: { press: [{ do: 'state.toggle', path: 'todo.done' }] } }]
            },
            { type: 'text', if: { $: 'todos.length == 0' }, props: { text: 'All done.' } }
        ]
    }
};

function* turn(size: number): Generator<UIChunk> {
    const text = JSON.stringify({ spec });
    yield { type: 'start', messageId: 'm1' };
    for (let i = 0; i < text.length; i += size) yield { type: 'tool-input', id: 'c1', name: 'render_ui', delta: text.slice(i, i + size) };
    yield { type: 'tool-call', id: 'c1', name: 'render_ui', input: JSON.parse(text) };
    yield { type: 'tool-result', id: 'c1', output: { rendered: true, issues: [] } };
    yield { type: 'finish', reason: 'stop' };
}

function mountPart(onRuntime: (r: UIRuntime) => void, onError: (e: Error) => void) {
    const message = signal(createMessage('assistant', []));
    const View = component(() => () => {
        const part = message.parts.find((p) => p.type === 'tool' && p.name === 'render_ui') as UIToolPart | undefined;
        if (!part) return null;
        return jsx(UIView, { spec: (part.input as { spec?: UISpec } | undefined)?.spec, done: part.state !== 'streaming', registry: webRegistry(), onRuntime, onActionError: onError });
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(jsx(View, {})).mount(container);
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return { message, container };
}

describe('a render_ui tool part streaming through the core reducer', () => {
    for (const size of [3, 7, 24, 100]) {
        it(`renders through ${size}-character deltas without throwing and converges`, { timeout: 30_000 }, async () => {
            let runtime!: UIRuntime;
            const errors: string[] = [];
            const { message, container } = mountPart((r) => (runtime = r), (e) => errors.push(e.message));
            for (const chunk of turn(size)) {
                applyChunk(message, chunk);
                await tick();
            }
            expect(errors).toEqual([]);
            expect(runtime.doc.status).toBe('done');
            expect(runtime.doc.issues).toEqual([]);
            expect(runtime.state.todos).toEqual(spec.state!.todos);
            expect(container.querySelector('.json-ui-text--caption')?.textContent).toBe('1 of 2 left');
            expect(container.querySelectorAll('.row')).toHaveLength(2);
        });
    }

    it('what the user typed mid-stream survives the rest of the state block', async () => {
        let runtime!: UIRuntime;
        const { message, container } = mountPart((r) => (runtime = r), () => {});
        const chunks = [...turn(24)];
        // Stream until the input exists, type into it, then let the rest land —
        // including the settled `tool-call`, whose full spec says `draft: ""`.
        // (Not before its `bind` path has fully arrived — `"bind":"dra` is a different key.)
        let cut = 0;
        const ready = () => container.querySelector('input') && JSON.stringify(runtime.doc.spec).includes('"bind":"draft","props"');
        for (; cut < chunks.length && !ready(); cut++) {
            applyChunk(message, chunks[cut]!);
            await tick();
        }
        expect(chunks[cut - 1]!.type).toBe('tool-input');
        const input = container.querySelector('input')!;
        input.value = 'mine';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        for (const chunk of chunks.slice(cut)) {
            applyChunk(message, chunk);
            await tick();
        }
        expect(runtime.state.draft).toBe('mine');
        expect(runtime.state.todos).toEqual(spec.state!.todos);
        expect(input.value).toBe('mine');
    });
});
