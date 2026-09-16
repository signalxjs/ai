import { describe, it, expect } from 'vitest';
import { signal, effect } from '@sigx/reactivity';
import { childScope, defaultHelpers, evaluate, evaluateSource, parseExpr, type EvalEnv } from '../../src/expr/index.js';

const env = (state: Record<string, unknown>, extra: Partial<EvalEnv> = {}): EvalEnv => ({ helpers: defaultHelpers, state, ...extra });
const run = (src: string, state: Record<string, unknown> = {}, vars: Record<string, unknown> = {}, extra: Partial<EvalEnv> = {}) =>
    evaluate(parseExpr(src), childScope(undefined, vars), env(state, extra));

describe('evaluate', () => {
    it('reads state, scope variables and computed lookups in that order', () => {
        expect(run('count + 1', { count: 2 })).toBe(3);
        expect(run('it.done', {}, { it: { done: true } })).toBe(true);
        expect(run('count', { count: 1 }, { count: 9 })).toBe(9);
        expect(run('remaining', { remaining: 1 }, {}, { lookup: (n) => (n === 'remaining' ? 7 : undefined) })).toBe(7);
    });

    it('is tolerant: a missing member is undefined, never a throw', () => {
        expect(run('user.address.city', {})).toBeUndefined();
        expect(run('todos[3].title', { todos: [] })).toBeUndefined();
        expect(run('a ?? "x"', {})).toBe('x');
    });

    it('never surfaces prototype or function values', () => {
        expect(run('a.constructor', { a: {} })).toBeUndefined();
        expect(run('a.__proto__', { a: {} })).toBeUndefined();
        expect(run('a["constructor"]', { a: {} })).toBeUndefined();
        expect(run('a.toString', { a: {} })).toBeUndefined();
        expect(run('f', { f: () => 1 })).toBeUndefined();
        expect(run('"x".constructor', {})).toBeUndefined();
    });

    it('shields $-prefixed keys of data objects (the proxy `$set`) but resolves $ scope vars', () => {
        const state = signal({ a: 1 }) as Record<string, unknown>;
        expect(run('$set', state)).toBeUndefined();
        expect(run('a.$set', { a: signal({ b: 1 }) })).toBeUndefined();
        expect(run('$event.value', {}, { $event: { value: 'v' } })).toBe('v');
    });

    it('does arithmetic, string concatenation and loose equality on JSON values', () => {
        expect(run('"n=" + 3', {})).toBe('n=3');
        expect(run('"" + nothing', {})).toBe('');
        expect(run('1 + "2"', {})).toBe('12');
        expect(run('7 % 3 * 2 - 1', {})).toBe(1);
        expect(run('a == null', {})).toBe(true);
        expect(run('a != null', { a: 0 })).toBe(true);
        expect(run('"1" == 1', {})).toBe(true);
        expect(run('!done && count > 0 ? "yes" : "no"', { done: false, count: 1 })).toBe('yes');
    });

    it('builds arrays and objects', () => {
        expect(run('[a, a + 1]', { a: 1 })).toEqual([1, 2]);
        expect(run('{ id: 1, title: draft, "x y": true }', { draft: 'd' })).toEqual({ id: 1, title: 'd', 'x y': true });
        expect(run('{ __proto__: 1 }', {})).toEqual({});
    });

    it('calls helpers eagerly, lazy helpers per item with `it` and `index`, and method sugar through the same table', () => {
        const todos = [
            { title: 'a', done: true },
            { title: 'b', done: false }
        ];
        expect(run('count(todos, !it.done)', { todos })).toBe(1);
        expect(run('map(todos, it.title + index)', { todos })).toEqual(['a0', 'b1']);
        expect(run('todos.filter(it.done).length', { todos })).toBe(1);
        expect(run('where(todos, !it.done)[0].title', { todos })).toBe('b');
        expect(run("map(todos, it.title).join(', ')", { todos })).toBe('a, b');
        expect(run('sum(cart, it.price * it.qty)', { cart: [{ price: 2, qty: 3 }, { price: 1, qty: 1 }] })).toBe(7);
        expect(run('todos.length', { todos })).toBe(2);
        expect(run('"abc".length', {})).toBe(3);
        expect(run('upper(name)', { name: 'x' })).toBe('X');
        expect(run('name.toUpperCase()', { name: 'x' })).toBe('X');
        expect(run('sortBy(todos, it.title, "desc")[0].title', { todos })).toBe('b');
        expect(run('find(todos, it.title == "b").done', { todos })).toBe(false);
        expect(run('range(3)', {})).toEqual([0, 1, 2]);
        expect(run('len(range(100000))', {})).toBe(10_000);
        expect(run('round(1.2345, 2)', {})).toBe(1.23);
    });

    it('throws on an unknown helper and yields undefined for an unknown method', () => {
        expect(() => run('nope(1)', {})).toThrow(/unknown helper/);
        expect(run('a.nope()', { a: [] })).toBeUndefined();
    });

    it('evaluateSource returns undefined on a parse error unless strict', () => {
        expect(evaluateSource('a +', undefined, env({}))).toBeUndefined();
        expect(() => evaluateSource('a +', undefined, env({}), true)).toThrow();
    });

    it('tracks reads through a reactive state, including keys that do not exist yet', () => {
        const state = signal({} as Record<string, unknown>);
        const seen: unknown[] = [];
        effect(() => {
            seen.push(evaluateSource('user.name ?? "anon"', undefined, env(state)));
        });
        state.user = { name: 'Ann' };
        (state.user as { name: string }).name = 'Bo';
        expect(seen).toEqual(['anon', 'Ann', 'Bo']);
    });
});
