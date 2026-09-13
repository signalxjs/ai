/** `generateText` — `streamText`, drained into one result. */

import { assembleMessage, messageText, type FinishReason, type UIMessage, type Usage } from '../protocol/index.js';
import type { StandardSchemaV1 } from '../schema/index.js';
import { resumedMessage, streamText, type OutputOptions, type StreamTextOptions } from './stream-text.js';

export interface GenerateTextResult<O = unknown> {
    readonly text: string;
    readonly reasoning: string;
    readonly message: UIMessage;
    readonly finishReason: FinishReason;
    readonly usage?: Usage;
    readonly toolCalls: readonly { id: string; name: string; input: unknown; output?: unknown; isError?: boolean }[];
    /** The validated structured result — present when the call asked for `output` and `finishReason` is `'stop'`. */
    readonly output?: O;
}

/**
 * `streamText`, drained. Throws on an `error` chunk. A transcript that
 * resumes an assistant message (approved / awaiting tool calls) yields that
 * whole message — its earlier parts plus what this turn added — not just
 * the new chunks. With `output`, the result's `output` is typed by the schema;
 * it is present exactly when `finishReason` is `'stop'` — a turn cut short by
 * the token limit, a refusal, or one deferred to the client has none.
 */
export function generateText<S extends StandardSchemaV1>(
    options: StreamTextOptions & { readonly output: OutputOptions & { readonly schema: S } }
): Promise<GenerateTextResult<StandardSchemaV1.InferOutput<S>>>;
export function generateText(options: StreamTextOptions): Promise<GenerateTextResult>;
export async function generateText(options: StreamTextOptions): Promise<GenerateTextResult> {
    const resumed = resumedMessage(options.messages);
    const { message, last } = await assembleMessage(
        streamText(options),
        // A copy: the caller's transcript is input, never mutated.
        resumed ? { id: resumed.id, role: resumed.role, parts: resumed.parts.map((p) => ({ ...p })) } : undefined
    );
    if (last?.type === 'error') throw new Error(last.message);
    const finish = last?.type === 'finish' ? last : undefined;
    let reasoning = '';
    const toolCalls: { id: string; name: string; input: unknown; output?: unknown; isError?: boolean }[] = [];
    for (const p of message.parts) {
        if (p.type === 'reasoning') reasoning += p.text;
        else if (p.type === 'tool') toolCalls.push({ id: p.id, name: p.name, input: p.input, output: p.output, ...(p.state === 'error' || p.state === 'denied' ? { isError: true } : {}) });
    }
    return {
        text: messageText(message),
        reasoning,
        message,
        finishReason: finish?.reason ?? 'other',
        ...(finish?.usage ? { usage: finish.usage } : {}),
        toolCalls,
        ...(finish && finish.output !== undefined ? { output: finish.output } : {})
    };
}
