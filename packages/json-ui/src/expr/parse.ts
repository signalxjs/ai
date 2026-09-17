/**
 * A Pratt parser for the expression language, plus the `{{…}}` template
 * scanner. Caps on source length and nesting depth keep a hostile or
 * runaway model output from costing more than a parse should.
 */

import { ExprError, type BinaryOp, type Expr, type Template } from './ast.js';
import { tokenize, type Token } from './tokenize.js';

export const MAX_SOURCE_LENGTH = 2000;
export const MAX_DEPTH = 32;

const BINARY: Readonly<Record<string, number>> = {
    '??': 2,
    '||': 3,
    '&&': 4,
    '==': 5,
    '!=': 5,
    '===': 5,
    '!==': 5,
    '<': 6,
    '<=': 6,
    '>': 6,
    '>=': 6,
    '+': 7,
    '-': 7,
    '*': 8,
    '/': 8,
    '%': 8
};

class Parser {
    private i = 0;
    private depth = 0;
    constructor(
        private readonly tokens: Token[],
        private readonly source: string
    ) {}

    private peek(): Token {
        return this.tokens[this.i]!;
    }
    private next(): Token {
        return this.tokens[this.i++]!;
    }
    private isP(v: string): boolean {
        const t = this.peek();
        return t.t === 'p' && t.v === v;
    }
    private expectP(v: string): void {
        const t = this.next();
        if (t.t !== 'p' || t.v !== v) throw new ExprError(`expected "${v}"`, this.source, t.pos);
    }
    private enter(): void {
        if (++this.depth > MAX_DEPTH) throw new ExprError(`expression nests deeper than ${MAX_DEPTH}`, this.source, this.peek().pos);
    }
    private leave(): void {
        this.depth--;
    }

    parseAll(): Expr {
        const e = this.expr(0);
        const t = this.peek();
        if (t.t !== 'end') throw new ExprError(`unexpected "${t.v}"`, this.source, t.pos);
        return e;
    }

    /** Precedence climbing: `minBp` is the lowest binding power this call may consume. */
    private expr(minBp: number): Expr {
        this.enter();
        let left = this.unary();
        for (;;) {
            const t = this.peek();
            if (t.t !== 'p') break;
            if (t.v === '?' && minBp <= 1) {
                this.next();
                const then = this.expr(0);
                this.expectP(':');
                const otherwise = this.expr(1);
                left = { k: 'cond', test: left, yes: then, no: otherwise };
                continue;
            }
            const bp = BINARY[t.v];
            if (bp === undefined || bp < minBp || bp <= 1) break;
            this.next();
            const right = this.expr(bp + 1);
            if (t.v === '&&' || t.v === '||' || t.v === '??') left = { k: 'logic', op: t.v, l: left, r: right };
            else {
                const op = (t.v === '===' ? '==' : t.v === '!==' ? '!=' : t.v) as BinaryOp;
                left = { k: 'bin', op, l: left, r: right };
            }
        }
        this.leave();
        return left;
    }

    private unary(): Expr {
        const t = this.peek();
        if (t.t === 'p' && (t.v === '!' || t.v === '-' || t.v === '+')) {
            this.next();
            this.enter();
            const arg = this.unary();
            this.leave();
            // Fold a negative literal so `-1` is a number, not an operation.
            if (t.v === '-' && arg.k === 'lit' && typeof arg.v === 'number') return { k: 'lit', v: -arg.v };
            return { k: 'unary', op: t.v, arg };
        }
        return this.postfix();
    }

    private postfix(): Expr {
        let e = this.primary();
        for (;;) {
            const t = this.peek();
            if (t.t !== 'p') break;
            if (t.v === '.' || t.v === '?.') {
                this.next();
                const name = this.next();
                if (name.t !== 'id') throw new ExprError('expected a property name', this.source, name.pos);
                if (this.isP('(')) {
                    this.next();
                    e = { k: 'mcall', obj: e, method: name.v, args: this.args(')') };
                } else e = { k: 'member', obj: e, prop: name.v };
                continue;
            }
            if (t.v === '[' || t.v === '?.[') {
                this.next();
                const index = this.expr(0);
                this.expectP(']');
                e = { k: 'index', obj: e, index };
                continue;
            }
            if (t.v === '(') {
                if (e.k !== 'id') throw new ExprError('only helpers can be called', this.source, t.pos);
                this.next();
                e = { k: 'call', name: e.name, args: this.args(')') };
                continue;
            }
            break;
        }
        return e;
    }

    private args(close: string): Expr[] {
        const out: Expr[] = [];
        while (!this.isP(close)) {
            out.push(this.expr(0));
            if (this.isP(',')) {
                this.next();
                continue;
            }
            if (!this.isP(close)) throw new ExprError(`expected "," or "${close}"`, this.source, this.peek().pos);
        }
        this.expectP(close);
        return out;
    }

    private primary(): Expr {
        const t = this.next();
        switch (t.t) {
            case 'num':
                return { k: 'lit', v: t.v };
            case 'str':
                return { k: 'lit', v: t.v };
            case 'id':
                switch (t.v) {
                    case 'true':
                        return { k: 'lit', v: true };
                    case 'false':
                        return { k: 'lit', v: false };
                    case 'null':
                        return { k: 'lit', v: null };
                    case 'undefined':
                        return { k: 'lit', v: undefined };
                    default:
                        return { k: 'id', name: t.v };
                }
            case 'p':
                if (t.v === '(') {
                    const e = this.expr(0);
                    this.expectP(')');
                    return e;
                }
                if (t.v === '[') {
                    this.enter();
                    const items = this.args(']');
                    this.leave();
                    return { k: 'array', items };
                }
                if (t.v === '{') {
                    this.enter();
                    const entries: { key: string; value: Expr }[] = [];
                    while (!this.isP('}')) {
                        const key = this.next();
                        if (key.t !== 'id' && key.t !== 'str') throw new ExprError('expected a property name', this.source, key.pos);
                        let value: Expr;
                        if (this.isP(':')) {
                            this.next();
                            value = this.expr(0);
                        } else if (key.t === 'id') value = { k: 'id', name: key.v }; // `{ title }` shorthand
                        else throw new ExprError('expected ":"', this.source, this.peek().pos);
                        entries.push({ key: key.v, value });
                        if (this.isP(',')) this.next();
                        else if (!this.isP('}')) throw new ExprError('expected "," or "}"', this.source, this.peek().pos);
                    }
                    this.expectP('}');
                    this.leave();
                    return { k: 'object', entries };
                }
                throw new ExprError(`unexpected "${t.v}"`, this.source, t.pos);
            case 'end':
                throw new ExprError('unexpected end of expression', this.source, t.pos);
        }
    }
}

/** Parse one expression. Throws `ExprError`. */
export function parseExpr(source: string): Expr {
    if (source.length > MAX_SOURCE_LENGTH) throw new ExprError(`expression longer than ${MAX_SOURCE_LENGTH} characters`, source, MAX_SOURCE_LENGTH);
    return new Parser(tokenize(source), source).parseAll();
}

/**
 * Parse a `{{…}}` template. An unterminated `{{` — the usual state of a
 * string still streaming in — is kept as literal text, never an error; a
 * malformed expression inside a closed `{{ }}` throws.
 */
export function parseTemplate(source: string): Template {
    const out: (string | Expr)[] = [];
    let i = 0;
    for (;;) {
        const open = source.indexOf('{{', i);
        if (open < 0) break;
        const close = source.indexOf('}}', open + 2);
        if (close < 0) break;
        if (open > i) out.push(source.slice(i, open));
        const inner = source.slice(open + 2, close);
        if (inner.trim()) out.push(parseExpr(inner));
        i = close + 2;
    }
    if (i < source.length) out.push(source.slice(i));
    return out;
}

/** `true` when the string carries at least one closed `{{…}}`. */
export function hasTemplate(source: string): boolean {
    const open = source.indexOf('{{');
    return open >= 0 && source.indexOf('}}', open + 2) >= 0;
}
