/**
 * The default helper table. Every helper is pure, tolerant of `null` /
 * `undefined` and size-capped. Lazy helpers take a predicate EXPRESSION as
 * their second argument and evaluate it per element with `it` (and `index`)
 * bound — that is how the language does per-item logic without lambdas.
 */

import type { Expr } from './ast.js';
import { toText, type EagerHelper, type HelperContext, type HelperTable, type LazyHelper } from './evaluate.js';

/** Elements any list helper looks at, at most. */
export const MAX_ITEMS = 10_000;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v.length > MAX_ITEMS ? v.slice(0, MAX_ITEMS) : v) : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : v == null || v === '' ? 0 : Number(v));

function lazy(fn: (items: unknown[], pick: (item: unknown, i: number) => unknown, args: readonly Expr[], ctx: HelperContext) => unknown): LazyHelper {
    return {
        lazy: true,
        call(args, ctx) {
            const items = list(ctx.eval(args[0]!));
            const pred = args[1];
            const pick = (item: unknown, i: number): unknown => (pred ? ctx.eval(pred, { it: item, index: i }) : item);
            return fn(items, pick, args, ctx);
        }
    };
}

const eager = (fn: (...args: unknown[]) => unknown): EagerHelper => (args) => fn(...args);

let uidSeq = 0;
function uid(): string {
    const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
    if (c?.randomUUID) return c.randomUUID().slice(0, 8);
    return `id${(++uidSeq).toString(36)}${Date.now().toString(36).slice(-4)}`;
}

function compare(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = toText(a);
    const sb = toText(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export const defaultHelpers: HelperTable = {
    // --- lists, lazy predicate ---
    where: lazy((items, pick) => items.filter((it, i) => !!pick(it, i))),
    count: lazy((items, pick, args) => (args[1] ? items.filter((it, i) => !!pick(it, i)).length : items.length)),
    map: lazy((items, pick) => items.map(pick)),
    find: lazy((items, pick) => items.find((it, i) => !!pick(it, i))),
    any: lazy((items, pick) => items.some((it, i) => !!pick(it, i))),
    all: lazy((items, pick) => items.every((it, i) => !!pick(it, i))),
    sum: lazy((items, pick) => items.reduce<number>((acc, it, i) => acc + num(pick(it, i)), 0)),
    avg: lazy((items, pick) => (items.length ? items.reduce<number>((acc, it, i) => acc + num(pick(it, i)), 0) / items.length : 0)),
    min: lazy((items, pick) => (items.length ? Math.min(...items.map((it, i) => num(pick(it, i)))) : undefined)),
    max: lazy((items, pick) => (items.length ? Math.max(...items.map((it, i) => num(pick(it, i)))) : undefined)),
    sortBy: lazy((items, pick, args, ctx) => {
        const dir = args[2] ? toText(ctx.eval(args[2])) : 'asc';
        const keyed = items.map((it, i) => ({ it, key: pick(it, i) }));
        keyed.sort((a, b) => compare(a.key, b.key));
        if (dir === 'desc') keyed.reverse();
        return keyed.map((k) => k.it);
    }),
    // --- lists, eager ---
    len: eager((v) => (Array.isArray(v) ? v.length : typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0)),
    first: eager((v) => list(v)[0]),
    last: eager((v) => {
        const l = list(v);
        return l[l.length - 1];
    }),
    at: eager((v, i) => list(v).at(num(i))),
    reverse: eager((v) => [...list(v)].reverse()),
    uniq: eager((v) => [...new Set(list(v))]),
    range: eager((a, b) => {
        const start = b === undefined ? 0 : num(a);
        const end = b === undefined ? num(a) : num(b);
        const out: number[] = [];
        for (let i = start; i < end && out.length < MAX_ITEMS; i++) out.push(i);
        return out;
    }),
    join: eager((v, sep) => list(v).map(toText).join(sep === undefined ? ',' : toText(sep))),
    includes: eager((v, x) => (typeof v === 'string' ? v.includes(toText(x)) : list(v).includes(x))),
    indexOf: eager((v, x) => (typeof v === 'string' ? v.indexOf(toText(x)) : list(v).indexOf(x))),
    slice: eager((v, a, b) => (typeof v === 'string' ? v.slice(num(a), b === undefined ? undefined : num(b)) : list(v).slice(num(a), b === undefined ? undefined : num(b)))),
    keys: eager((v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((k) => !k.startsWith('$')) : [])),
    values: eager((v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.keys(v)
                  .filter((k) => !k.startsWith('$'))
                  .map((k) => (v as Record<string, unknown>)[k])
            : []
    ),
    entries: eager((v) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.keys(v)
                  .filter((k) => !k.startsWith('$'))
                  .map((k) => ({ key: k, value: (v as Record<string, unknown>)[k] }))
            : []
    ),
    // --- strings ---
    str: eager((v) => toText(v)),
    trim: eager((v) => toText(v).trim()),
    upper: eager((v) => toText(v).toUpperCase()),
    lower: eager((v) => toText(v).toLowerCase()),
    startsWith: eager((v, x) => toText(v).startsWith(toText(x))),
    endsWith: eager((v, x) => toText(v).endsWith(toText(x))),
    split: eager((v, sep) => toText(v).split(toText(sep)).slice(0, MAX_ITEMS)),
    replace: eager((v, a, b) => toText(v).split(toText(a)).join(toText(b))),
    json: eager((v) => {
        try {
            return JSON.stringify(v);
        } catch {
            return '';
        }
    }),
    // --- numbers ---
    num: eager((v) => num(v)),
    bool: eager((v) => !!v),
    round: eager((v, d) => {
        const f = 10 ** num(d);
        return Math.round(num(v) * f) / f;
    }),
    floor: eager((v) => Math.floor(num(v))),
    ceil: eager((v) => Math.ceil(num(v))),
    abs: eager((v) => Math.abs(num(v))),
    clamp: eager((v, lo, hi) => Math.min(Math.max(num(v), num(lo)), num(hi))),
    toFixed: eager((v, d) => num(v).toFixed(num(d))),
    format: eager((v, decimals) => {
        const n = num(v);
        const d = decimals === undefined ? undefined : num(decimals);
        return n.toLocaleString(undefined, d === undefined ? undefined : { minimumFractionDigits: d, maximumFractionDigits: d });
    }),
    // --- misc ---
    coalesce: eager((...args) => args.find((a) => a != null)),
    uid: eager(() => uid()),
    now: eager(() => Date.now()),
    date: eager((v, style) => {
        const d = v === undefined ? new Date() : new Date(v as string | number);
        if (Number.isNaN(d.getTime())) return '';
        const s = style === undefined ? 'date' : toText(style);
        if (s === 'iso') return d.toISOString();
        if (s === 'time') return d.toLocaleTimeString();
        if (s === 'datetime') return d.toLocaleString();
        return d.toLocaleDateString();
    })
};
