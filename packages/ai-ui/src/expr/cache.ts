/**
 * A bounded parse cache keyed by source string. Bounded because a streaming
 * spec produces every prefix of every expression (`c`, `co`, `cou`, …), and
 * errors are cached too so a half-typed expression is not re-parsed on
 * every render of the node that holds it.
 */

import { ExprError, type Expr, type Template } from './ast.js';
import { parseExpr, parseTemplate } from './parse.js';

const MAX_ENTRIES = 2000;

function bounded<V>(): { get(k: string): V | undefined; set(k: string, v: V): void } {
    const map = new Map<string, V>();
    return {
        get: (k) => map.get(k),
        set(k, v) {
            if (map.size >= MAX_ENTRIES) {
                const oldest = map.keys().next().value;
                if (oldest !== undefined) map.delete(oldest);
            }
            map.set(k, v);
        }
    };
}

const exprs = bounded<Expr | ExprError>();
const templates = bounded<Template | ExprError>();

/** Parsed expression or the `ExprError` it raised — never throws. A non-string (a `{$}` still streaming in) is an error too. */
export function parseCached(source: unknown): Expr | ExprError {
    if (typeof source !== 'string') return new ExprError('expected an expression string', source, 0);
    const hit = exprs.get(source);
    if (hit) return hit;
    let result: Expr | ExprError;
    try {
        result = parseExpr(source);
    } catch (e) {
        result = e instanceof ExprError ? e : new ExprError(e instanceof Error ? e.message : String(e), source, 0);
    }
    exprs.set(source, result);
    return result;
}

export function templateCached(source: unknown): Template | ExprError {
    if (typeof source !== 'string') return new ExprError('expected a template string', source, 0);
    const hit = templates.get(source);
    if (hit) return hit;
    let result: Template | ExprError;
    try {
        result = parseTemplate(source);
    } catch (e) {
        result = e instanceof ExprError ? e : new ExprError(e instanceof Error ? e.message : String(e), source, 0);
    }
    templates.set(source, result);
    return result;
}
