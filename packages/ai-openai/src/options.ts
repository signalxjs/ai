/** Construction options for the OpenAI provider. */

import type OpenAI from 'openai';

export interface OpenAIProviderOptions {
    /** Read from `OPENAI_API_KEY` when omitted. */
    readonly apiKey?: string;
    /** A pre-built client — Azure, a proxy base URL, custom retries. */
    readonly client?: OpenAI;
    /** Merged under every request's `providerOptions`. */
    readonly defaultOptions?: Readonly<Record<string, unknown>>;
}
