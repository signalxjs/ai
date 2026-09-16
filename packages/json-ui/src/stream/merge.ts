/**
 * `mergeDeep` — fold a newer version of a JSON tree into an existing one IN
 * PLACE, writing only the leaves that changed. Works on a plain object and
 * on a reactive proxy alike; on a proxy every write is one fine-grained
 * signal, so a string still being typed (`"Hel"` → `"Hell"`) is one property
 * write on one node, and a node that did not change keeps its identity —
 * which is what keeps a keyed component mounted while the rest of the spec
 * streams in.
 *
 * Rules that matter on a proxy: compare against `toRaw(target)` (reads
 * through the proxy are tracked and `Object.keys` on it is costly), and
 * never keep a literal just stored — go back through `parent[k]` so the
 * recursion sees the proxied child.
 */

import { toRaw } from '@sigx/reactivity';
import { isPlainObject } from '../spec/types.js';

type Container = Record<string | number, unknown>;

export function mergeDeep(target: Record<string, unknown> | unknown[], next: unknown): void {
    if (Array.isArray(target)) {
        if (Array.isArray(next)) mergeArray(target, next);
        return;
    }
    if (isPlainObject(next)) mergeObject(target, next);
}

function mergeObject(target: Record<string, unknown>, next: Record<string, unknown>): void {
    const raw = toRaw(target) as Record<string, unknown>;
    for (const k of Object.keys(next)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        mergeValue(target as Container, raw as Container, k, next[k]);
    }
    for (const k of Object.keys(raw)) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) delete target[k];
    }
}

function mergeArray(target: unknown[], next: unknown[]): void {
    const raw = toRaw(target) as unknown[];
    const common = Math.min(raw.length, next.length);
    for (let i = 0; i < common; i++) mergeValue(target as unknown as Container, raw as unknown as Container, i, next[i]);
    for (let i = raw.length; i < next.length; i++) target.push(next[i]);
    if (raw.length > next.length) target.splice(next.length);
}

function mergeValue(parent: Container, raw: Container, key: string | number, value: unknown): void {
    const cur = raw[key];
    if (Array.isArray(value)) {
        if (Array.isArray(cur)) mergeArray(parent[key] as unknown[], value);
        else parent[key] = value;
        return;
    }
    if (isPlainObject(value)) {
        if (isPlainObject(cur) && !Array.isArray(cur)) mergeObject(parent[key] as Record<string, unknown>, value);
        else parent[key] = value;
        return;
    }
    if (cur !== value || !(key in raw)) parent[key] = value;
}
