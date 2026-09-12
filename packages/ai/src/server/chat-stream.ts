/**
 * `@sigx/ai/server` — the glue between the engine and a `serverStream`.
 *
 * ```ts
 * // src/ai.server.ts
 * export const chat = serverStream({
 *     input: ChatInput,
 *     handler: async function* (rq, input) {
 *         yield* chatStream({ model, tools, messages: input.messages, signal: rq.abortSignal });
 *     }
 * });
 * ```
 *
 * `ChatInput` is a dependency-free Standard Schema for `{ messages: UIMessage[] }`
 * — the wire is attacker-controlled, so the transcript is checked
 * structurally before the model sees it. Bring your own schema (Zod, …) to
 * add fields.
 */

import { streamText, type StreamTextOptions } from '../engine/index.js';
import type { UIChunk, UIMessage } from '../protocol/index.js';

export interface ChatStreamOptions extends Omit<StreamTextOptions, 'messages'> {
    readonly messages: readonly UIMessage[];
}

/** One assistant turn for a transcript, as UI chunks. Alias of `streamText` typed for the wire. */
export function chatStream(options: ChatStreamOptions): AsyncGenerator<UIChunk, void, undefined> {
    return streamText(options);
}

/** Only the text deltas — a string stream `useStream` consumes as-is. */
export async function* toTextStream(chunks: AsyncIterable<UIChunk>): AsyncGenerator<string, void, undefined> {
    for await (const chunk of chunks) {
        if (chunk.type === 'text') yield chunk.delta;
        else if (chunk.type === 'error') throw new Error(chunk.message);
    }
}
