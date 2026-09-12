/** Construction options for the Anthropic provider. */

import type Anthropic from '@anthropic-ai/sdk';

export interface AnthropicProviderOptions {
    /** Read from `ANTHROPIC_API_KEY` (or an `ant auth login` profile) when omitted. */
    readonly apiKey?: string;
    /** A pre-built client — Vertex, Bedrock Mantle, Foundry, or one with custom retries. */
    readonly client?: Anthropic;
    /** Merged under every request's `providerOptions`. */
    readonly defaultOptions?: Readonly<Record<string, unknown>>;
    /** `max_tokens` when a request does not say; default 64000. */
    readonly defaultMaxTokens?: number;
}
