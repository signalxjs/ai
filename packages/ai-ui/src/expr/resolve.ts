/**
 * Spec values → runtime values. `{ "$": expr }` evaluates, a string with
 * `{{…}}` interpolates, arrays and objects resolve recursively, everything
 * else passes through. Plus `lvalue()`, the write-side counterpart used by
 * `bind` and the `state.*` actions.
 */

import { ExprError, type Expr } from './ast.js';
import { parseCached, templateCached } from './cache.js';
import { evaluate, lookupVar, NOT_FOUND, safeGet, toText, type EvalEnv, type Scope } from './evaluate.js';
import { isExprValue } from '../spec/types.js';

/** Evaluate a source string; a parse error yields `undefined` (streaming-tolerant) unless `strict`. */
export function evaluateSource(source: string, scope: Scope | undefined, env: EvalEnv, strict = false): unknown {
    const ast = parseCached(source);
    if (ast instanceof ExprError) {
        if (strict) throw ast;
        return undefined;
    }
    return evaluate(ast, scope, env);
}

export function evaluateTemplate(source: string, scope: Scope | undefined, env: EvalEnv): string {
    const tpl = templateCached(source);
    if (tpl instanceof ExprError) return source;
    let out = '';
    for (const part of tpl) out += typeof part === 'string' ? part : toText(evaluate(part, scope, env));
    return out;
}

const MAX_RESOLVE_DEPTH = 64;

/** Resolve one spec value into a plain runtime value. Reads through proxies are tracked by the caller's context. */
export function resolveValue(value: unknown, scope: Scope | undefined, env: EvalEnv, depth = 0): unknown {
    if (depth > MAX_RESOLVE_DEPTH) return undefined;
    if (typeof value === 'string') return value.includes('{{') ? evaluateTemplate(value, scope, env) : value;
    if (typeof value !== 'object' || value === null) return value;
    if (isExprValue(value)) return evaluateSource(value.$, scope, env);
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope, env, depth + 1));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
        if (k.startsWith('$')) continue;
        out[k] = resolveValue((value as Record<string, unknown>)[k], scope, env, depth + 1);
    }
    return out;
}

export interface LValue {
    readonly container: Record<string, unknown> | unknown[];
    readonly key: string | number;
}

/** `true` when `expr` is a chain of identifier, member and index steps — something a value can be written to. */
export function isLValueExpr(expr: Expr): boolean {
    for (let e = expr; ; ) {
        if (e.k === 'id') return true;
        if (e.k === 'member') e = e.obj;
        else if (e.k === 'index') e = e.obj;
        else return false;
    }
}

/**
 * Resolve a path (`draft`, `form.email`, `todos[2].done`, `todo.done`) to the
 * object that holds it and the key to write. The root is a scope variable
 * when one is bound by that name (a loop item, say), else runtime state.
 * Missing intermediate objects are created when `create` is set.
 */
export function lvalue(path: string, scope: Scope | undefined, env: EvalEnv, create = false): LValue | undefined {
    const ast = parseCached(path);
    if (ast instanceof ExprError || !isLValueExpr(ast)) return undefined;
    if (ast.k === 'id') {
        if (ast.name.startsWith('$')) return undefined;
        const v = lookupVar(scope, ast.name);
        // A bound loop variable is an item, not a slot: `todo` alone is not writable.
        if (v !== NOT_FOUND) return undefined;
        return { container: env.state, key: ast.name };
    }
    if (ast.k !== 'member' && ast.k !== 'index') return undefined;
    const container = resolveContainer(ast.obj, scope, env, create);
    if (!container) return undefined;
    const key = ast.k === 'member' ? ast.prop : evaluate(ast.index, scope, env);
    if (typeof key === 'number') return Array.isArray(container) || typeof container === 'object' ? { container, key } : undefined;
    if (typeof key !== 'string' || key.startsWith('$') || key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    return { container, key };
}

function resolveContainer(expr: Expr, scope: Scope | undefined, env: EvalEnv, create: boolean): Record<string, unknown> | unknown[] | undefined {
    if (expr.k === 'id') {
        const v = lookupVar(scope, expr.name);
        if (v !== NOT_FOUND) return isContainer(v) ? v : undefined;
        if (expr.name.startsWith('$')) return undefined;
        let s = safeGet(env.state, expr.name);
        if (s === undefined && create) {
            env.state[expr.name] = {};
            s = env.state[expr.name];
        }
        return isContainer(s) ? s : undefined;
    }
    if (expr.k !== 'member' && expr.k !== 'index') return undefined;
    const parent = resolveContainer(expr.obj, scope, env, create);
    if (!parent) return undefined;
    const key = expr.k === 'member' ? expr.prop : evaluate(expr.index, scope, env);
    let v = safeGet(parent, key);
    if (v === undefined && create && (typeof key === 'string' || typeof key === 'number')) {
        (parent as Record<string | number, unknown>)[key] = {};
        v = safeGet(parent, key);
    }
    return isContainer(v) ? v : undefined;
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
    return typeof v === 'object' && v !== null;
}
