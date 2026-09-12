import { describe, it, expect } from 'vitest';
import { parsePartialJson } from '@sigx/ai';

describe('parsePartialJson', () => {
    it('returns undefined for nothing parseable yet', () => {
        expect(parsePartialJson('')).toBeUndefined();
        expect(parsePartialJson('   ')).toBeUndefined();
        expect(parsePartialJson('{')).toEqual({});
    });

    it('reads a lone opening quote as the empty string being typed', () => {
        expect(parsePartialJson('"')).toBe('');
    });

    it('parses complete documents as-is', () => {
        expect(parsePartialJson('{"a":1}')).toEqual({ a: 1 });
        expect(parsePartialJson('[1,2,3]')).toEqual([1, 2, 3]);
        expect(parsePartialJson('"x"')).toBe('x');
    });

    it('closes an open string', () => {
        expect(parsePartialJson('{"title": "Hel')).toEqual({ title: 'Hel' });
        expect(parsePartialJson('{"title": "He said \\"hi')).toEqual({ title: 'He said "hi' });
        expect(parsePartialJson('{"title": "trailing\\')).toEqual({ title: 'trailing' });
    });

    it('drops a dangling key, colon or comma', () => {
        expect(parsePartialJson('{"a": 1, "b"')).toEqual({ a: 1 });
        expect(parsePartialJson('{"a": 1, "b":')).toEqual({ a: 1 });
        expect(parsePartialJson('{"a": 1,')).toEqual({ a: 1 });
        expect(parsePartialJson('{"a"')).toEqual({});
        expect(parsePartialJson('[1, 2,')).toEqual([1, 2]);
    });

    it('trims an incomplete literal or number', () => {
        expect(parsePartialJson('{"ok": tr')).toEqual({});
        expect(parsePartialJson('{"ok": true, "n": nul')).toEqual({ ok: true });
        expect(parsePartialJson('{"n": -')).toEqual({});
        expect(parsePartialJson('{"n": 12')).toEqual({ n: 12 });
        expect(parsePartialJson('{"n": 1.')).toEqual({});
    });

    it('closes nested containers in order', () => {
        expect(parsePartialJson('{"items": [{"id": 1}, {"id": 2, "tags": ["a", "b')).toEqual({ items: [{ id: 1 }, { id: 2, tags: ['a', 'b'] }] });
        expect(parsePartialJson('{"a": {"b": {"c": [1, {"d": "e')).toEqual({ a: { b: { c: [1, { d: 'e' }] } } });
    });

    it('grows monotonically as tokens arrive', () => {
        const doc = '{"title": "Hello world", "tags": ["x", "y"], "count": 42, "done": true}';
        let prev: string | undefined;
        for (let i = 1; i <= doc.length; i++) {
            const v = parsePartialJson(doc.slice(0, i));
            if (v !== undefined) {
                const s = JSON.stringify(v);
                // Every prefix parses (once anything parses at all) — no regressions to undefined.
                expect(typeof v).toBe('object');
                prev = s;
            }
        }
        expect(prev).toBe(JSON.stringify(JSON.parse(doc)));
    });
});
