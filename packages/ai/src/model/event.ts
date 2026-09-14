/** What a provider yields, and the usage arithmetic the engine does over a turn. */

import type { FinishReason, Usage } from '../protocol/index.js';

/**
 * What a provider yields. Mirrors the UI chunks plus the things only the
 * engine consumes (`providerData` for replay).
 *
 * `tool-input-delta` is a call's arguments arriving as raw JSON text, before
 * the assembled `tool-call`. It carries the SAME `id` and `name` that call
 * will, so a UI can label the chip and settle it in place; the engine
 * forwards it as the `tool-input` chunk.
 */
export type ModelEvent =
    | { readonly type: 'text-delta'; readonly delta: string }
    | { readonly type: 'reasoning-delta'; readonly delta: string }
    | { readonly type: 'reasoning-end'; readonly providerData?: unknown }
    | { readonly type: 'tool-input-delta'; readonly id: string; readonly name: string; readonly delta: string }
    | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly input: unknown }
    | { readonly type: 'finish'; readonly reason: FinishReason; readonly usage?: Usage; readonly providerData?: unknown }
    | { readonly type: 'error'; readonly error: unknown };

/** Sum two usages field by field (a tool loop reports the whole turn). */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
    if (!a) return b;
    if (!b) return a;
    const out: Usage = { ...a };
    for (const [k, v] of Object.entries(b)) {
        if (typeof v !== 'number') continue;
        const cur = out[k];
        out[k] = typeof cur === 'number' ? cur + v : v;
    }
    return out;
}
