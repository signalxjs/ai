import { describe, it, expect } from 'vitest';
import { effect, signal, toRaw } from '@sigx/reactivity';
import { mergeDeep } from '../../src/stream/index.js';

describe('mergeDeep', () => {
    it('writes only changed leaves and keeps untouched subtrees by identity', () => {
        const doc = signal({ root: { type: 'stack', children: [{ type: 'text', props: { text: 'Hel' } }] } } as Record<string, unknown>);
        const rootRaw = toRaw(doc.root);
        const childRaw = toRaw((doc.root as { children: unknown[] }).children[0]);
        mergeDeep(doc, { root: { type: 'stack', children: [{ type: 'text', props: { text: 'Hello' } }, { type: 'button' }] } });
        expect(toRaw(doc.root)).toBe(rootRaw);
        expect(toRaw((doc.root as { children: unknown[] }).children[0])).toBe(childRaw);
        expect(doc).toEqual({ root: { type: 'stack', children: [{ type: 'text', props: { text: 'Hello' } }, { type: 'button' }] } });
    });

    it('a typed string is one write per merge; unrelated readers do not re-run', () => {
        const doc = signal({ root: { type: 'text', props: { text: 'H' } }, state: { n: 1 } } as Record<string, unknown>);
        let textRuns = 0;
        let stateRuns = 0;
        effect(() => {
            void (doc.root as { props: { text: string } }).props.text;
            textRuns++;
        });
        effect(() => {
            void (doc.state as { n: number }).n;
            stateRuns++;
        });
        mergeDeep(doc, { root: { type: 'text', props: { text: 'He' } }, state: { n: 1 } });
        mergeDeep(doc, { root: { type: 'text', props: { text: 'Hel' } }, state: { n: 1 } });
        expect(textRuns).toBe(3);
        expect(stateRuns).toBe(1);
    });

    it('grows and shrinks arrays, deletes vanished keys, replaces on kind change', () => {
        const t = signal({ a: [1, 2, 3], b: { x: 1 }, c: 'gone' } as Record<string, unknown>);
        mergeDeep(t, { a: [1, 9], b: [1], d: null });
        expect(t).toEqual({ a: [1, 9], b: [1], d: null });
        mergeDeep(t, { a: [1, 9, 10, 11] });
        expect(t.a).toEqual([1, 9, 10, 11]);
    });

    it('converges: any chunking of a document equals a single merge, with the same node identities', () => {
        const full = {
            state: { todos: [{ id: 1, title: 'one' }] },
            root: { type: 'stack', props: { gap: 8 }, children: [{ type: 'text', props: { text: 'Todos: {{todos.length}}' } }, { type: 'list', for: { items: { $: 'todos' } }, children: [{ type: 'text', props: { text: '{{item.title}}' } }] }] }
        };
        const json = JSON.stringify(full);
        // Hand-rolled partial prefixes at every cut point are not valid JSON; use structural prefixes instead:
        // each step adds one more leaf, in document order.
        const steps: unknown[] = [
            {},
            { state: {} },
            { state: { todos: [] } },
            { state: { todos: [{ id: 1 }] } },
            { state: { todos: [{ id: 1, title: 'on' }] } },
            { state: { todos: [{ id: 1, title: 'one' }] }, root: { type: 'st' } },
            { state: { todos: [{ id: 1, title: 'one' }] }, root: { type: 'stack', props: { gap: 8 }, children: [{ type: 'text', props: { text: 'Todos: {{to' } }] } },
            { state: { todos: [{ id: 1, title: 'one' }] }, root: { type: 'stack', props: { gap: 8 }, children: [{ type: 'text', props: { text: 'Todos: {{todos.length}}' } }, { type: 'list', for: { items: { $: 'todos' } } }] } },
            full
        ];
        const streamed = signal({} as Record<string, unknown>);
        for (const step of steps) mergeDeep(streamed, step);
        const firstChildAfterStep6 = (() => {
            const s = signal({} as Record<string, unknown>);
            for (const step of steps.slice(0, 7)) mergeDeep(s, step);
            return s;
        })();
        void firstChildAfterStep6;
        expect(JSON.stringify(streamed)).toBe(json);
        // identity: the first child created at step 7 is the same raw object at the end
        const s = signal({} as Record<string, unknown>);
        for (const step of steps.slice(0, 7)) mergeDeep(s, step);
        const child0 = toRaw((s.root as { children: unknown[] }).children[0]);
        for (const step of steps.slice(7)) mergeDeep(s, step);
        expect(toRaw((s.root as { children: unknown[] }).children[0])).toBe(child0);
    });

    it('ignores prototype keys', () => {
        const t = signal({} as Record<string, unknown>);
        mergeDeep(t, JSON.parse('{"__proto__": {"polluted": 1}, "ok": 1}'));
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(t.ok).toBe(1);
    });
});
