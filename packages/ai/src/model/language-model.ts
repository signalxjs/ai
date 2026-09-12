/**
 * The model seam — what a provider package implements.
 *
 * A provider only TRANSLATES: our request shape to its SDK's, its stream
 * events to `ModelEvent`. The tool loop and abort handling live in the
 * engine, message assembly and the UI protocol in `protocol/` — once. That
 * is the whole point of the seam: adding a vendor is a translator, not a
 * fork of the engine.
 */

import type { JsonSchema } from '../schema/index.js';
import type { ModelMessage } from './message.js';
import type { ModelEvent } from './event.js';

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
