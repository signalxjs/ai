/**
 * The model seam — what a provider package implements.
 *
 * A provider only TRANSLATES: our request shape to its SDK's, its stream
 * events to `ModelEvent`. The tool loop, message assembly, abort handling
 * and the UI protocol live in `engine.ts`, once. That is the whole point of
 * the seam: adding a vendor is a translator, not a fork of the engine.
 */

import type { JsonSchema } from './schema.js';
import type { FinishReason, Usage } from './protocol.js';

// ── Request ─────────────────────────────────────────────────────────────────

export interface LanguageModel {
    /** Vendor id, e.g. `'anthropic'`, `'openai'`, `'mock'`. */
    readonly provider: string;
    /** Vendor model id, e.g. `'claude-opus-5'`. */
    readonly modelId: string;
    /**
     * One model round. The iterable ends after a `finish` or `error` event —
     * with one exception: when `request.signal` aborts, a provider may end
     * the iterable with no terminal event at all (the abort is the caller's
     * own act). The engine treats a silent end as `finish: 'other'`; a direct
     * consumer should do the same.
     */
    stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export interface ModelRequest {
    readonly system?: string;
    readonly messages: readonly ModelMessage[];
    readonly tools?: readonly ToolSpec[];
    readonly maxTokens?: number;
    readonly temperature?: number;
    /** Ask for a JSON document matching `schema` instead of prose. */
    readonly responseFormat?: { readonly type: 'json'; readonly schema: JsonSchema; readonly name?: string };
    readonly signal?: AbortSignal;
    /**
     * Vendor passthrough, merged LAST into the SDK request — `thinking`,
     * `output_config`, `fallbacks`, `betas` for Anthropic; `reasoning`,
     * `store` for OpenAI. Unknown to the core by design.
     */
    readonly providerOptions?: Readonly<Record<string, unknown>>;
}

/** Wire-ready tool description — name, prose, JSON Schema. */
export interface ToolSpec {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchema;
    /** Ask the provider to guarantee schema-valid arguments where it can. */
    readonly strict?: boolean;
}

// ── Messages ────────────────────────────────────────────────────────────────

export type ModelMessage = ModelUserMessage | ModelAssistantMessage | ModelToolMessage;

export interface ModelUserMessage {
    readonly role: 'user';
    readonly content: string | readonly ModelTextPart[];
}

export interface ModelAssistantMessage {
    readonly role: 'assistant';
    readonly content: readonly (ModelTextPart | ModelReasoningPart | ModelToolCallPart)[];
}

/** The results of every tool call in the previous assistant turn — ONE message. */
export interface ModelToolMessage {
    readonly role: 'tool';
    readonly content: readonly ModelToolResultPart[];
}

export interface ModelTextPart {
    readonly type: 'text';
    readonly text: string;
}

export interface ModelReasoningPart {
    readonly type: 'reasoning';
    readonly text: string;
    /** Provider replay data (a signed thinking block); passed back verbatim. */
    readonly providerData?: unknown;
}

export interface ModelToolCallPart {
    readonly type: 'tool-call';
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
}

export interface ModelToolResultPart {
    readonly type: 'tool-result';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly output: unknown;
    readonly isError?: boolean;
}

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * What a provider yields. Mirrors the UI chunks plus the things only the
 * engine consumes (`tool-input-delta` for progressive argument display,
 * `providerData` for replay).
 */
export type ModelEvent =
    | { readonly type: 'text-delta'; readonly delta: string }
    | { readonly type: 'reasoning-delta'; readonly delta: string }
    | { readonly type: 'reasoning-end'; readonly providerData?: unknown }
    | { readonly type: 'tool-input-delta'; readonly id: string; readonly delta: string }
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
