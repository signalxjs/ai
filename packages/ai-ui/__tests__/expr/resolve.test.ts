import { describe, it, expect } from 'vitest';
import { signal } from '@sigx/reactivity';
import { childScope, defaultHelpers, evaluateTemplate, lvalue, resolveValue, type EvalEnv } from '../../src/expr/index.js';

const env = (state: Record<string, unknown>): EvalEnv => ({ helpers: defaultHelpers, state });

describe('evaluateTemplate', () => {
    it('interpolates, stringifies and drops null', () => {
        expect(evaluateTemplate('{{count}} of {{total}} ({{missing}})', undefined, env({ count: 1, total: 2 }))).toBe('1 of 2 ()');
        expect(evaluateTemplate('{{ obj }}', undefined, env({ obj: { a: 1 } }))).toBe('{"a":1}');
    });
    it('renders a broken expression as the source text', () => {
        expect(evaluateTemplate('{{ a + }}', undefined, env({}))).toBe('{{ a + }}');
    });
});

describe('resolveValue', () => {
    it('resolves {$}, {{}} and nested structures, passing literals through', () => {
        const state = { count: 2, name: 'x' };
        expect(resolveValue({ $: 'count * 2' }, undefined, env(state))).toBe(4);
        expect(resolveValue('hi {{name}}', undefined, env(state))).toBe('hi x');
        expect(resolveValue(['a', { $: 'count' }, { deep: '{{name}}' }], undefined, env(state))).toEqual(['a', 2, { deep: 'x' }]);
        expect(resolveValue({ style: { width: { $: 'count + "px"' } } }, undefined, env(state))).toEqual({ style: { width: '2px' } });
        expect(resolveValue(7, undefined, env(state))).toBe(7);
        expect(resolveValue(null, undefined, env(state))).toBeNull();
    });
    it('a broken {$} resolves to undefined (tolerant while streaming)', () => {
        expect(resolveValue({ $: 'count +' }, undefined, env({}))).toBeUndefined();
    });
});

describe('lvalue', () => {
    it('roots a bare name in state and a dotted path in the object it names', () => {
        const state = { form: { email: 'a' }, list: [1, 2] } as Record<string, unknown>;
        expect(lvalue('draft', undefined, env(state))).toEqual({ container: state, key: 'draft', root: 'draft' });
        expect(lvalue('form.email', undefined, env(state))).toEqual({ container: state.form, key: 'email', root: 'form' });
        expect(lvalue('list[1]', undefined, env(state))).toEqual({ container: state.list, key: 1, root: 'list' });
    });
    it('roots a loop variable in the item (root undefined), and refuses to overwrite the variable itself', () => {
        const todo = { done: false };
        const scope = childScope(undefined, { todo });
        expect(lvalue('todo.done', scope, env({}))).toEqual({ container: todo, key: 'done', root: undefined });
        expect(lvalue('todo', scope, env({}))).toBeUndefined();
    });
    it('creates intermediates only when asked, and never through $ or prototype keys', () => {
        const state = signal({} as Record<string, unknown>);
        expect(lvalue('form.email', undefined, env(state))).toBeUndefined();
        const lv = lvalue('form.email', undefined, env(state), true);
        expect(lv?.key).toBe('email');
        expect(state.form).toEqual({});
        expect(lvalue('$set', undefined, env(state), true)).toBeUndefined();
        expect(lvalue('a.__proto__', undefined, env(state), true)).toBeUndefined();
        expect(lvalue('a + b', undefined, env(state))).toBeUndefined();
        expect(lvalue('f()', undefined, env(state))).toBeUndefined();
    });
});
