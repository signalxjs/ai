import { describe, it, expect, vi } from 'vitest';
import { signal } from '@sigx/reactivity';
import { childScope, createActionRunner, defaultHelpers, type ActionStep, type ActionRunnerOptions, type UISpec } from '../../src/index.js';

function setup(state: Record<string, unknown> = {}, extra: Partial<ActionRunnerOptions> = {}, spec: UISpec = {}) {
    const s = signal(state) as Record<string, unknown>;
    const errors: { message: string; step?: string }[] = [];
    const emitted: [string, unknown][] = [];
    const runner = createActionRunner({
        env: { helpers: defaultHelpers, state: s },
        spec: () => spec,
        emit: (name, payload) => emitted.push([name, payload]),
        onError: (e, at) => errors.push({ message: e.message, step: at.step?.do }),
        ...extra
    });
    return { state: s, runner, errors, emitted };
}

describe('createActionRunner', () => {
    it('runs steps in order, awaiting each, resolving arguments in scope', async () => {
        const { state, runner } = setup({ count: 1, log: [] as string[] });
        const order: string[] = [];
        const result = await runner.run(
            [
                { do: 'state.set', path: 'count', value: { $: 'count + 1' } },
                { do: 'delay', ms: 1, as: 'waited' },
                { do: 'state.push', path: 'log', value: 'after {{count}}' },
                { do: 'seq', steps: [{ do: 'state.set', path: 'count', value: 10 }], as: 'inner' }
            ],
            childScope(undefined, {}),
            {}
        );
        void order;
        expect(result.ok).toBe(true);
        expect(state.count).toBe(10);
        expect(state.log).toEqual(['after 2']);
    });

    it('state.* builtins: patch, remove by index and by predicate, toggle, paths into loop items', async () => {
        const { state, runner } = setup({ todos: [{ id: 1, done: false }, { id: 2, done: false }], form: { a: 1 } });
        const todo = (state.todos as { id: number; done: boolean }[])[1]!;
        await runner.run([{ do: 'state.toggle', path: 'todo.done' }], childScope(undefined, { todo }));
        expect((state.todos as { done: boolean }[])[1]!.done).toBe(true);
        await runner.run([{ do: 'state.patch', path: 'form', value: { b: 2 } }, { do: 'state.patch', value: { top: true } }]);
        expect(state.form).toEqual({ a: 1, b: 2 });
        expect(state.top).toBe(true);
        await runner.run([{ do: 'state.remove', path: 'todos', where: { $: 'it.id == 1' } }]);
        expect(state.todos).toEqual([{ id: 2, done: true }]);
        await runner.run([{ do: 'state.push', path: 'fresh', value: 'x' }, { do: 'state.remove', path: 'fresh', index: 0 }]);
        expect(state.fresh).toEqual([]);
    });

    it('`if` skips, `as` and $result bind, `catch` runs with $error', async () => {
        const { state, runner, errors } = setup({ n: 0 });
        const r = await runner.run([
            { do: 'state.set', if: { $: 'n > 5' }, path: 'n', value: 99 },
            { do: 'http', url: 'https://evil.example/x', catch: [{ do: 'state.set', path: 'err', value: '{{$error.message}}' }] },
            { do: 'seq', steps: [{ do: 'state.set', path: 'n', value: 1 }], as: 'seqResult' },
            { do: 'state.set', path: 'last', value: { $: '$result' } }
        ]);
        expect(r.ok).toBe(true);
        expect(state.n).toBe(1);
        expect(state.err).toMatch(/not an allowed host/);
        expect(errors).toEqual([]);
    });

    it('an uncaught failure lands in onError with the step, never rejects', async () => {
        const { runner, errors } = setup();
        const r = await runner.run([{ do: 'nope' }, { do: 'state.set', path: 'x', value: 1 }]);
        expect(r.ok).toBe(false);
        expect(errors).toEqual([{ message: 'unknown action "nope"', step: 'nope' }]);
        const bad = await runner.run([{ do: 'state.set', path: '$set', value: 1 }]);
        expect(bad.ok).toBe(false);
        expect(errors[1]?.message).toMatch(/not a writable path/);
    });

    it('abort stops the run before the next state write', async () => {
        const { state, runner } = setup({ n: 0 });
        const controller = new AbortController();
        const p = runner.run([{ do: 'delay', ms: 50 }, { do: 'state.set', path: 'n', value: 1 }], undefined, { signal: controller.signal });
        controller.abort();
        const r = await p;
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.aborted).toBe(true);
        expect(state.n).toBe(0);
    });

    it('`call` runs a named spec action with $args; `emit` reaches the host; host actions override built-ins', async () => {
        const hostSet = vi.fn();
        const { state, runner, emitted } = setup(
            { total: 0 },
            { actions: { 'cart.add': async (args, ctx) => { (ctx.state.total as number) += Number(args.qty); return 'added'; }, log: hostSet } },
            { actions: { bump: [{ do: 'cart.add', qty: { $: '$args.qty' }, as: 'r' }, { do: 'emit', name: 'done', payload: { $: 'r' } }] } }
        );
        const r = await runner.run([{ do: 'call', action: 'bump', args: { qty: 3 } }, { do: 'log', message: 'x' }]);
        expect(r.ok).toBe(true);
        expect(state.total).toBe(3);
        expect(emitted).toEqual([['done', 'added']]);
        expect(hostSet).toHaveBeenCalled();
    });

    it('`all` runs steps in parallel and collects results', async () => {
        const { runner } = setup({}, { actions: { two: () => 2, three: async () => 3 } });
        const r = await runner.run([{ do: 'all', steps: [{ do: 'two' }, { do: 'three' }] }]);
        expect(r.ok && r.result).toEqual([2, 3]);
    });

    it('http: relative URLs always allowed, absolute only when the host is listed; JSON in and out; abort forwarded', async () => {
        const calls: [string, RequestInit][] = [];
        const fetchMock = (async (url: string, init: RequestInit) => {
            calls.push([url, init]);
            return new Response(JSON.stringify({ hello: 'world' }), { status: 200 });
        }) as unknown as typeof fetch;
        const { state, runner, errors } = setup({}, { http: { fetch: fetchMock, allowHosts: ['api.example.com', '*.trusted.org'], baseUrl: 'http://localhost:3000/' } });
        await runner.run([
            { do: 'http', url: '/api/items', method: 'POST', body: { a: 1 }, as: 'res' },
            { do: 'state.set', path: 'got', value: { $: 'res.data.hello' } },
            { do: 'http', url: 'https://api.example.com/x' },
            { do: 'http', url: 'https://deep.trusted.org/x' },
            { do: 'http', url: 'https://other.example.com/x', catch: [{ do: 'state.set', path: 'blocked', value: true }] }
        ]);
        expect(errors).toEqual([]);
        expect(state.got).toBe('world');
        expect(state.blocked).toBe(true);
        expect(calls.map((c) => c[0])).toEqual(['http://localhost:3000/api/items', 'https://api.example.com/x', 'https://deep.trusted.org/x']);
        expect(calls[0]![1].method).toBe('POST');
        expect((calls[0]![1].headers as Record<string, string>)['content-type']).toBe('application/json');
        expect(calls[0]![1].body).toBe('{"a":1}');
    });

    it('consecutive guarded steps are one decision: the calculator digit chains GPT-5 writes press one digit, not two', async () => {
        // Two cases guarded by `overwrite` / `!overwrite`: the first flips `overwrite`, the second must not see that.
        const twoIfs = [
            { do: 'state.patch', if: { $: 'overwrite' }, value: { input: { $: '$args.d' }, overwrite: false } },
            { do: 'state.set', if: { $: '!overwrite' }, path: 'input', value: { $: "input == '0' ? $args.d : input + $args.d" } }
        ];
        // The three-way chain from a real spec, followed by an unguarded step that must see the writes.
        const pressDigit = [
            { do: 'state.patch', if: { $: 'error' }, value: { display: { $: '$args.d' }, current: { $: '$args.d' }, overwrite: false, error: false } },
            { do: 'state.patch', if: { $: '!error && overwrite' }, value: { current: { $: '$args.d' }, overwrite: false } },
            { do: 'state.set', if: { $: '!error && !overwrite' }, path: 'current', value: { $: "current == '0' ? $args.d : current + $args.d" } },
            { do: 'state.set', path: 'display', value: { $: 'current' } }
        ];
        {
            const { state, runner } = setup({ input: '1', overwrite: true });
            await runner.run(twoIfs, childScope(undefined, { $args: { d: '2' } }));
            expect(state.input).toBe('2');
        }
        {
            const { state, runner } = setup({ display: '0', current: '0', overwrite: true, error: false });
            const press = (d: string) => runner.run(pressDigit, childScope(undefined, { $args: { d } }));
            await press('1');
            expect(state).toMatchObject({ current: '1', display: '1', overwrite: false });
            await press('2');
            expect(state).toMatchObject({ current: '12', display: '12' });
            state.error = true;
            await press('7');
            expect(state).toMatchObject({ current: '7', display: '7', error: false });
        }
    });

    it('a guard after an unguarded step sees its write; `as` results are live inside a group; `else` runs when `if` is false', async () => {
        const { state, runner } = setup({ n: 0, flag: false }, { actions: { probe: () => ({ ok: true }) } });
        await runner.run([
            { do: 'state.set', path: 'flag', value: true },
            { do: 'state.set', if: { $: 'flag' }, path: 'sawFlag', value: true },
            { do: 'probe', if: { $: 'flag' }, as: 'r' },
            { do: 'state.set', if: { $: 'r.ok' }, path: 'sawResult', value: true },
            { do: 'state.set', if: { $: 'n > 0' }, path: 'a', value: 1, else: [{ do: 'state.set', path: 'b', value: 2 }] }
        ]);
        expect(state).toEqual({ n: 0, flag: true, sawFlag: true, sawResult: true, b: 2 });
    });

    it('a step that is not an object is an error', async () => {
        const { runner, errors } = setup();
        await runner.run(['nope' as unknown as ActionStep]);
        expect(errors[0]?.message).toMatch(/a step must be/);
    });
});
