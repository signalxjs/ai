import { describe, it, expect } from 'vitest';
import { baseCatalog, defineCatalog, uiSpecSchema, validateSpec, type UISpec } from '../../src/index.js';

const todo: UISpec = {
    version: 1,
    state: { draft: '', todos: [] },
    computed: { remaining: { $: 'count(todos, !it.done)' } },
    actions: { add: [{ do: 'state.push', path: 'todos', value: { $: '{ id: uid(), title: draft, done: false }' } }, { do: 'state.set', path: 'draft', value: '' }] },
    root: {
        type: 'stack',
        props: { gap: 8 },
        children: [
            { type: 'text', props: { text: '{{remaining}} left', variant: 'heading' } },
            { type: 'input', bind: 'draft', props: { placeholder: 'Todo' }, on: { submit: [{ do: 'call', action: 'add' }] } },
            { type: 'button', props: { label: 'Add', disabled: { $: 'draft == ""' } }, on: { press: [{ do: 'call', action: 'add' }] } },
            { type: 'list', for: { items: { $: 'todos' }, as: 'todo', key: { $: 'todo.id' } }, children: [{ type: 'text', props: { text: '{{todo.title}}' }, on: { press: [{ do: 'state.toggle', path: 'todo.done' }] } }] },
            { type: 'text', if: { $: 'todos.length == 0' }, props: { text: 'Nothing yet' } }
        ]
    }
};

const messages = (spec: unknown, mode: 'streaming' | 'final' = 'final') => validateSpec(spec, baseCatalog, { mode }).map((i) => `${i.severity} ${i.path.join('.')}: ${i.message}`);

describe('validateSpec', () => {
    it('accepts the todo spec', () => {
        expect(messages(todo)).toEqual([]);
    });

    it('final mode reports unknown components, missing required props, enums, bad expressions and unknown helpers/actions', () => {
        expect(messages({ root: { type: 'nope' } })).toEqual(['error root.type: unknown component "nope"']);
        expect(messages({ root: { type: 'button' } })).toEqual(['error root.props.label: required']);
        expect(messages({ root: { type: 'button', props: { label: 'x', variant: 'huge' } } })).toEqual(['error root.props.variant: must be one of primary, secondary, ghost, danger']);
        expect(messages({ root: { type: 'text', props: { text: { $: 'a +' } } } })[0]).toMatch(/bad expression/);
        expect(messages({ root: { type: 'text', props: { text: '{{ nope(1) }}' } } })).toEqual(['error root.props.text: unknown helper "nope"']);
        expect(messages({ root: { type: 'text', props: { text: { $: 'a.foo()' } } } })).toEqual(['error root.props.text: unknown method ".foo()" — use a helper']);
        expect(messages({ root: { type: 'button', props: { label: 'x' }, on: { press: [{ do: 'explode' }] } } })).toEqual(['error root.on.press.0.do: unknown action "explode"']);
        expect(messages({ root: { type: 'button', props: { label: 'x' }, on: { press: [{ do: 'call', action: 'nope' }] } } })).toEqual(['error root.on.press.0.action: no spec action named "nope"']);
        expect(messages({ root: { type: 'input', bind: 'a + b' } })).toEqual(['error root.bind: must be a writable path like "draft" or "form.email"']);
        expect(messages({ root: { type: 'text', props: { text: 'x', style: 'color: red' } } })).toEqual(['error root.props.style: style must be an object, not a string']);
    });

    it('final mode warns on unknown props, unknown events, children on a leaf and bind on a non-bindable', () => {
        expect(messages({ root: { type: 'text', props: { text: 'x', size: 1 }, on: { hover: [] }, children: [{ type: 'divider' }], bind: 'x' } })).toEqual([
            'warning root.props.size: unknown prop "size" on text',
            'warning root.bind: text does not support bind',
            'warning root.on.hover: text has no "hover" event',
            'warning root.children: text takes no children'
        ]);
    });

    it('warns about two adjacent steps guarded by X and !X, and accepts else', () => {
        const pair = { root: { type: 'button', props: { label: 'x' }, on: { press: [
            { do: 'state.set', if: { $: 'overwrite' }, path: 'a', value: 1 },
            { do: 'state.set', if: { $: '!(overwrite)' }, path: 'a', value: 2 }
        ] } } };
        expect(messages(pair)).toEqual(['warning root.on.press.1.if: negates the previous step\'s "if", but is evaluated AFTER that step ran — if that step changes what the condition reads, both run. Put these steps in the previous step\'s "else" instead.']);
        const withElse = { root: { type: 'button', props: { label: 'x' }, on: { press: [
            { do: 'state.set', if: { $: 'overwrite' }, path: 'a', value: 1, else: [{ do: 'state.set', path: 'a', value: 2 }] }
        ] } } };
        expect(messages(withElse)).toEqual([]);
        expect(messages({ root: { type: 'button', props: { label: 'x' }, on: { press: [{ do: 'log', else: [{ do: 'nope' }] }] } } })).toEqual([
            'warning root.on.press.0.else: has no "if" to be the else of',
            'error root.on.press.0.else.0.do: unknown action "nope"'
        ]);
    });

    it('streaming mode only reports kind mismatches', () => {
        expect(messages({ root: { type: 'te', props: { lab: 'x' }, children: [{ type: 'butt' }] } }, 'streaming')).toEqual([]);
        expect(messages({ root: { type: 'button', props: { label: 'x', disabled: 'yes' } } }, 'streaming')).toEqual(['error root.props.disabled: must be a boolean']);
        expect(messages({ root: { type: 'stack', children: 'nope' } }, 'streaming')).toEqual(['error root.children: must be an array of nodes']);
        expect(messages({ root: { type: 'text', props: { text: { $: 'a +' } } } }, 'streaming')).toEqual([]);
        expect(messages({}, 'streaming')).toEqual([]);
        expect(messages({}, 'final')).toEqual(['error root: required']);
    });

    it('a custom catalog extends the base one', () => {
        const catalog = defineCatalog({ extends: baseCatalog, components: { chart: { description: 'A chart', props: { series: { type: 'array', required: true } } } } });
        expect(validateSpec({ root: { type: 'chart', props: { series: [1] } } }, catalog)).toEqual([]);
        expect(validateSpec({ root: { type: 'chart', props: { series: 1 } } }, catalog)[0]?.message).toBe('must be an array');
    });

    it('uiSpecSchema is a Standard Schema that fails on errors only', async () => {
        const schema = uiSpecSchema(baseCatalog);
        const ok = await schema['~standard'].validate(todo);
        expect('value' in ok && ok.value).toBe(todo);
        const bad = await schema['~standard'].validate({ root: { type: 'nope' } });
        expect('issues' in bad && bad.issues?.[0]?.path).toEqual(['root', 'type']);
        const warnOnly = await schema['~standard'].validate({ root: { type: 'text', props: { text: 'x', size: 1 } } });
        expect('value' in warnOnly).toBe(true);
    });
});
