import { describe, it, expect } from 'vitest';
import { signal, effect, toRaw, computed } from '@sigx/reactivity';

describe('the reactivity facts the renderer relies on', () => {
    it('tracks a missing key and re-runs when it arrives', () => {
        const s = signal({} as Record<string, unknown>);
        const seen: unknown[] = [];
        effect(() => { seen.push((s as Record<string, unknown>).title); });
        s.title = 'x';
        expect(seen).toEqual([undefined, 'x']);
    });
    it('toRaw on a plain object returns it; on a proxy returns the raw; nested proxies share raw identity', () => {
        const plain = { a: { b: 1 } };
        expect(toRaw(plain)).toBe(plain);
        const s = signal(plain);
        expect(toRaw(s)).toBe(plain);
        expect(toRaw(s.a)).toBe(plain.a);
        expect(s.a).toBe(s.a);
    });
    it('a string write is one effect run; unrelated key writes do not re-run', () => {
        const s = signal({ props: { text: 'He', other: 1 } });
        let runs = 0;
        effect(() => { void s.props.text; runs++; });
        s.props.text = 'Hel';
        s.props.other = 2;
        expect(runs).toBe(2);
    });
    it('array push re-runs a length/iteration reader', () => {
        const s = signal({ items: [] as number[] });
        let runs = 0;
        effect(() => { s.items.forEach(() => {}); runs++; });
        s.items.push(1);
        expect(runs).toBe(2);
    });
    it('$set exists on proxies and Object.keys works', () => {
        const s = signal({ a: 1 } as Record<string, unknown>);
        expect(typeof (s as { $set?: unknown }).$set).toBe('function');
        expect(Object.keys(s)).toEqual(['a']);
        const c = computed(() => (s.a as number) + 1);
        expect(c.value).toBe(2);
        s.a = 5;
        expect(c.value).toBe(6);
    });
});
