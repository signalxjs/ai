import { describe, it, expect } from 'vitest';
import { ExprError, parseExpr, parseTemplate, MAX_DEPTH } from '../../src/expr/index.js';

describe('parseExpr', () => {
    it('parses literals, identifiers and member chains', () => {
        expect(parseExpr('42')).toEqual({ k: 'lit', v: 42 });
        expect(parseExpr("'a\\nb'")).toEqual({ k: 'lit', v: 'a\nb' });
        expect(parseExpr('null')).toEqual({ k: 'lit', v: null });
        expect(parseExpr('user.name')).toEqual({ k: 'member', obj: { k: 'id', name: 'user' }, prop: 'name' });
        expect(parseExpr('todos[0]?.title')).toEqual({
            k: 'member',
            obj: { k: 'index', obj: { k: 'id', name: 'todos' }, index: { k: 'lit', v: 0 } },
            prop: 'title'
        });
    });

    it('honours precedence: mul over add over comparison over && over || over ?? over ternary', () => {
        const e = parseExpr('a + b * 2 > 3 && ok || fallback ?? x ? 1 : 2');
        expect(e.k).toBe('cond');
        if (e.k !== 'cond') return;
        expect(e.test.k).toBe('logic');
        if (e.test.k !== 'logic') return;
        expect(e.test.op).toBe('??');
        expect(e.test.l).toMatchObject({ k: 'logic', op: '||' });
        const or = e.test.l;
        if (or.k !== 'logic') return;
        expect(or.l).toMatchObject({ k: 'logic', op: '&&', l: { k: 'bin', op: '>', l: { k: 'bin', op: '+', r: { k: 'bin', op: '*' } } } });
    });

    it('nests ternaries to the right', () => {
        expect(parseExpr('a ? 1 : b ? 2 : 3')).toMatchObject({ k: 'cond', no: { k: 'cond' } });
    });

    it('normalizes === and !== to == and !=', () => {
        expect(parseExpr('a === 1')).toMatchObject({ k: 'bin', op: '==' });
        expect(parseExpr('a !== 1')).toMatchObject({ k: 'bin', op: '!=' });
    });

    it('folds a negative number literal', () => {
        expect(parseExpr('-1.5')).toEqual({ k: 'lit', v: -1.5 });
        expect(parseExpr('-x')).toEqual({ k: 'unary', op: '-', arg: { k: 'id', name: 'x' } });
    });

    it('parses helper calls and method sugar', () => {
        expect(parseExpr('count(todos, !it.done)')).toMatchObject({ k: 'call', name: 'count' });
        expect(parseExpr("list.join(', ')")).toMatchObject({ k: 'mcall', method: 'join', obj: { k: 'id', name: 'list' } });
        expect(() => parseExpr('user.name()')).not.toThrow();
        expect(() => parseExpr('[a](1)')).toThrow(ExprError);
        expect(() => parseExpr('a.b(1)(2)')).toThrow(ExprError);
    });

    it('parses array and object literals, with shorthand and trailing commas', () => {
        expect(parseExpr('[1, 2,]')).toMatchObject({ k: 'array', items: [{ v: 1 }, { v: 2 }] });
        expect(parseExpr('{ id: uid(), title, "done": false }')).toMatchObject({
            k: 'object',
            entries: [{ key: 'id', value: { k: 'call' } }, { key: 'title', value: { k: 'id', name: 'title' } }, { key: 'done', value: { v: false } }]
        });
    });

    it('rejects what the language leaves out, with a position', () => {
        for (const bad of ['a = 1', 'x => x', 'new Foo()', 'typeof x', 'a; b', '`t`', 'a.b.', 'foo(', '1 +']) {
            expect(() => parseExpr(bad), bad).toThrow(ExprError);
        }
        try {
            parseExpr('a +');
        } catch (e) {
            expect((e as ExprError).pos).toBe(3);
        }
    });

    it('caps nesting depth and length', () => {
        expect(() => parseExpr('('.repeat(MAX_DEPTH + 2) + '1' + ')'.repeat(MAX_DEPTH + 2))).toThrow(/deeper/);
        expect(() => parseExpr('1 + '.repeat(600) + '1')).toThrow(/longer/);
    });
});

describe('parseTemplate', () => {
    it('splits text and expressions', () => {
        expect(parseTemplate('{{count}} items of {{ total }}!')).toEqual([{ k: 'id', name: 'count' }, ' items of ', { k: 'id', name: 'total' }, '!']);
    });
    it('keeps an unterminated {{ as text (a string still streaming)', () => {
        expect(parseTemplate('Hello {{na')).toEqual(['Hello {{na']);
    });
    it('a string without templates is one text part', () => {
        expect(parseTemplate('plain')).toEqual(['plain']);
    });
    it('throws on a bad expression inside a closed pair', () => {
        expect(() => parseTemplate('{{ a + }}')).toThrow(ExprError);
    });
});
