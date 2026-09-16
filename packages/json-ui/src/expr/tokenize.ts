/** Tokenizer for the expression language — one pass, positions kept for error messages. */

import { ExprError } from './ast.js';

export type Token =
    | { readonly t: 'num'; readonly v: number; readonly pos: number }
    | { readonly t: 'str'; readonly v: string; readonly pos: number }
    | { readonly t: 'id'; readonly v: string; readonly pos: number }
    | { readonly t: 'p'; readonly v: string; readonly pos: number }
    | { readonly t: 'end'; readonly v: ''; readonly pos: number };

/** Longest first, so `===` wins over `==` over `=`. */
const PUNCT = ['===', '!==', '?.[', '?.', '??', '==', '!=', '<=', '>=', '&&', '||', '(', ')', '[', ']', '{', '}', ',', ':', '.', '?', '+', '-', '*', '/', '%', '!', '<', '>'];

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

export function tokenize(source: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    const n = source.length;
    while (i < n) {
        const c = source[i]!;
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
            continue;
        }
        const pos = i;
        if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
            let j = i;
            while (j < n && isDigit(source[j]!)) j++;
            if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
                j++;
                while (j < n && isDigit(source[j]!)) j++;
            }
            if ((source[j] === 'e' || source[j] === 'E') && /[0-9+-]/.test(source[j + 1] ?? '')) {
                j++;
                if (source[j] === '+' || source[j] === '-') j++;
                while (j < n && isDigit(source[j]!)) j++;
            }
            out.push({ t: 'num', v: Number(source.slice(i, j)), pos });
            i = j;
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            let v = '';
            for (;;) {
                if (j >= n) throw new ExprError('unterminated string', source, pos);
                const d = source[j]!;
                if (d === c) break;
                if (d === '\\') {
                    const e = source[j + 1];
                    if (e === undefined) throw new ExprError('unterminated string', source, pos);
                    if (e === 'n') v += '\n';
                    else if (e === 't') v += '\t';
                    else if (e === 'r') v += '\r';
                    else if (e === 'u') {
                        const hex = source.slice(j + 2, j + 6);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ExprError('bad unicode escape', source, j);
                        v += String.fromCharCode(parseInt(hex, 16));
                        j += 4;
                    } else v += e;
                    j += 2;
                    continue;
                }
                v += d;
                j++;
            }
            out.push({ t: 'str', v, pos });
            i = j + 1;
            continue;
        }
        if (isIdStart(c)) {
            let j = i + 1;
            while (j < n && isIdPart(source[j]!)) j++;
            out.push({ t: 'id', v: source.slice(i, j), pos });
            i = j;
            continue;
        }
        let matched = false;
        for (const p of PUNCT) {
            if (source.startsWith(p, i)) {
                out.push({ t: 'p', v: p, pos });
                i += p.length;
                matched = true;
                break;
            }
        }
        if (!matched) throw new ExprError(`unexpected character "${c}"`, source, pos);
    }
    out.push({ t: 'end', v: '', pos: n });
    return out;
}
