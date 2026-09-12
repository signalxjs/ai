/**
 * @sigx/ai-anthropic — Claude as a `LanguageModel`, on the official SDK.
 *
 * A translator and nothing more: our request → `client.messages.stream`,
 * its events → `ModelEvent`. Thinking blocks come back as `reasoning`
 * parts whose `providerData` is the signed block, so a transcript replayed
 * on the same model passes them back exactly as received (which tool use
 * with thinking requires). Adaptive thinking is the default; a caller who
 * wants readable reasoning passes `thinking: { type: 'adaptive', display:
 * 'summarized' }` through `providerOptions`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LanguageModel } from '@sigx/ai';
import type { AnthropicProviderOptions } from './options.js';
import { streamClaude } from './stream.js';

export interface AnthropicProvider {
    readonly client: Anthropic;
    model(modelId?: string): LanguageModel;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

export function anthropic(options: AnthropicProviderOptions = {}): AnthropicProvider {
    const client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
    return {
        client,
        model(modelId = DEFAULT_ANTHROPIC_MODEL): LanguageModel {
            return {
                provider: 'anthropic',
                modelId,
                stream: (request) => streamClaude(client, modelId, request, options)
            };
        }
    };
}
