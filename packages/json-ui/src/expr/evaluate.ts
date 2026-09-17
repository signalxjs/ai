/**
 * The evaluator — a tree walk over `Expr`. There is no tracking code here:
 * reads go through whatever objects the scope and state are (a reactive
 * proxy inside a render thunk), which is the whole reactive story.
 *
 * Security is structural: no function values ever surface, only own
 * properties are read, `__proto__` / `constructor` / `prototype` and
 * `$`-prefixed keys of data objects are unreachable (the latter shields the
 * reactive proxy's `$set`), and member access is tolerant (`undefined`, not
 * a throw) because half-built state is normal while a spec streams in.
 */

import type { Expr } from './ast.js';

export interface Scope {
    readonly vars: Record<string, unknown>;
    readonly parent?: Scope;
}

export interface HelperContext {
    /** Evaluate an argument expression, with extra variables in scope (`it`, `index`). */
    eval(expr: Expr, vars?: Record<string, unknown>): unknown;
    readonly scope: Scope;
}

/** An eager helper receives evaluated arguments. */
export type EagerHelper = (args: readonly unknown[], ctx: HelperContext) => unknown;
/** A lazy helper receives the argument ASTs and evaluates them itself — per item, with `it` bound. */
export interface LazyHelper {
    readonly lazy: true;
    readonly call: (args: readonly Expr[], ctx: HelperContext) => unknown;
}
export type Helper = EagerHelper | LazyHelper;
export type HelperTable = Readonly<Record<string, Helper>>;

export interface EvalEnv {
    readonly helpers: HelperTable;
    /** The runtime state object (a reactive proxy in the app). */
    readonly state: Record<string, unknown>;
    /** Names resolved before state — computed values. `undefined` falls through to state. */
    readonly lookup?: (name: string) => unknown;
    /** Method sugar: `list.filter(...)` → helper `where`. Defaults to `METHODS`. */
    readonly methods?: Readonly<Record<string, string>>;
}

export const METHODS: Readonly<Record<string, string>> = {
    filter: 'where',
    where: 'where',
    map: 'map',
    find: 'find',
    some: 'any',
    any: 'any',
    every: 'all',
    all: 'all',
    count: 'count',
    sum: 'sum',
    sortBy: 'sortBy',
    reverse: 'reverse',
    uniq: 'uniq',
    first: 'first',
    last: 'last',
    join: 'join',
    includes: 'includes',
    indexOf: 'indexOf',
    slice: 'slice',
    at: 'at',
    trim: 'trim',
    toUpperCase: 'upper',
    upper: 'upper',
    toLowerCase: 'lower',
    lower: 'lower',
    startsWith: 'startsWith',
    endsWith: 'endsWith',
    split: 'split',
    replace: 'replace',
    toFixed: 'toFixed',
    len: 'len'
};

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

export function childScope(parent: Scope | undefined, vars: Record<string, unknown>): Scope {
    return parent ? { vars, parent } : { vars };
}

export const NOT_FOUND: unique symbol = Symbol('not-found');

/** Walk the scope chain. */
export function lookupVar(scope: Scope | undefined, name: string): unknown | typeof NOT_FOUND {
    for (let s = scope; s; s = s.parent) {
        if (Object.prototype.hasOwnProperty.call(s.vars, name)) return s.vars[name];
    }
    return NOT_FOUND;
}

/** Own-property read with the guards above; `undefined` for anything unreachable. */
export function safeGet(obj: unknown, prop: unknown): unknown {
    if (obj == null) return undefined;
    if (typeof prop === 'number') {
        if (typeof obj === 'string') return obj[prop];
        if (Array.isArray(obj)) return obj[prop];
        prop = String(prop);
    }
    if (typeof prop !== 'string') return undefined;
    if (BLOCKED.has(prop) || prop.startsWith('$')) return undefined;
    if (typeof obj === 'string') return prop === 'length' ? obj.length : undefined;
    if (typeof obj !== 'object') return undefined;
    if (Array.isArray(obj)) {
        if (prop === 'length') return obj.length;
        const i = Number(prop);
        return Number.isInteger(i) && i >= 0 ? obj[i] : undefined;
    }
    // Read first so a reactive proxy records the dependency even when the
    // key is absent — it may stream in later.
    const v = (obj as Record<string, unknown>)[prop];
    if (typeof v === 'function') return undefined;
    return Object.prototype.hasOwnProperty.call(obj, prop) ? v : undefined;
}

export function truthy(v: unknown): boolean {
    return !!v;
}

function looseEq(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
    if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
    return false;
}

/** Text form used by `+` on strings and by templates: null/undefined vanish, objects go to JSON. */
export function toText(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
        try {
            return JSON.stringify(v);
        } catch {
            return '';
        }
    }
    return '';
}

export function evaluate(expr: Expr, scope: Scope | undefined, env: EvalEnv): unknown {
    switch (expr.k) {
        case 'lit':
            return expr.v;
        case 'id': {
            const v = lookupVar(scope, expr.name);
            if (v !== NOT_FOUND) return v;
            if (expr.name.startsWith('$')) return undefined;
            const c = env.lookup?.(expr.name);
            if (c !== undefined) return c;
            return safeGet(env.state, expr.name);
        }
        case 'member':
            return safeGet(evaluate(expr.obj, scope, env), expr.prop);
        case 'index':
            return safeGet(evaluate(expr.obj, scope, env), evaluate(expr.index, scope, env));
        case 'call':
            return callHelper(expr.name, expr.args, scope, env);
        case 'mcall': {
            const name = (env.methods ?? METHODS)[expr.method];
            if (!name) return undefined;
            return callHelper(name, [expr.obj, ...expr.args], scope, env);
        }
        case 'unary': {
            const v = evaluate(expr.arg, scope, env);
            if (expr.op === '!') return !v;
            const n = Number(v);
            return expr.op === '-' ? -n : n;
        }
        case 'logic': {
            const l = evaluate(expr.l, scope, env);
            if (expr.op === '&&') return l ? evaluate(expr.r, scope, env) : l;
            if (expr.op === '||') return l ? l : evaluate(expr.r, scope, env);
            return l ?? evaluate(expr.r, scope, env);
        }
        case 'cond':
            return evaluate(expr.test, scope, env) ? evaluate(expr.yes, scope, env) : evaluate(expr.no, scope, env);
        case 'bin': {
            const l = evaluate(expr.l, scope, env);
            const r = evaluate(expr.r, scope, env);
            switch (expr.op) {
                case '+':
                    if (typeof l === 'string' || typeof r === 'string') return toText(l) + toText(r);
                    return Number(l) + Number(r);
                case '-':
                    return Number(l) - Number(r);
                case '*':
                    return Number(l) * Number(r);
                case '/':
                    return Number(l) / Number(r);
                case '%':
                    return Number(l) % Number(r);
                case '==':
                    return looseEq(l, r);
                case '!=':
                    return !looseEq(l, r);
                case '<':
                    return (l as number) < (r as number);
                case '<=':
                    return (l as number) <= (r as number);
                case '>':
                    return (l as number) > (r as number);
                case '>=':
                    return (l as number) >= (r as number);
            }
            return undefined;
        }
        case 'array':
            return expr.items.map((e) => evaluate(e, scope, env));
        case 'object': {
            const out: Record<string, unknown> = {};
            for (const { key, value } of expr.entries) {
                if (BLOCKED.has(key)) continue;
                out[key] = evaluate(value, scope, env);
            }
            return out;
        }
    }
}

function callHelper(name: string, args: readonly Expr[], scope: Scope | undefined, env: EvalEnv): unknown {
    const helper = Object.prototype.hasOwnProperty.call(env.helpers, name) ? env.helpers[name] : undefined;
    if (!helper) throw new Error(`[sigx json-ui] unknown helper "${name}"`);
    const ctx: HelperContext = {
        scope: scope ?? { vars: {} },
        eval: (e, vars) => evaluate(e, vars ? childScope(scope, vars) : scope, env)
    };
    if (typeof helper === 'function') return helper(args.map((a) => evaluate(a, scope, env)), ctx);
    return helper.call(args, ctx);
}
