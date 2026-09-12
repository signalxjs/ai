/**
 * @sigx/ai-openai — OpenAI as a `LanguageModel`, on the official SDK's
 * Responses API.
 *
 * A translator and nothing more: our request → `client.responses.stream`,
 * its events → `ModelEvent`. Function calls stream their arguments and are
 * emitted as one `tool-call` when done; reasoning summaries stream as
 * `reasoning-delta`. A reasoning item that carries `encrypted_content`
 * (`store: false` + `include: ['reasoning.encrypted_content']`) is kept as
 * `providerData` so a replayed transcript passes it back.
 */

import OpenAI from 'openai';
import type { LanguageModel } from '@sigx/ai';
import type { OpenAIProviderOptions } from './options.js';
import { streamOpenAI } from './stream.js';

export interface OpenAIProvider {
    readonly client: OpenAI;
    model(modelId?: string): LanguageModel;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

export function openai(options: OpenAIProviderOptions = {}): OpenAIProvider {
    const client = options.client ?? new OpenAI(options.apiKey ? { apiKey: options.apiKey } : {});
    return {
        client,
        model(modelId = DEFAULT_OPENAI_MODEL): LanguageModel {
            return {
                provider: 'openai',
                modelId,
                stream: (request) => streamOpenAI(client, modelId, request, options)
            };
        }
    };
}
