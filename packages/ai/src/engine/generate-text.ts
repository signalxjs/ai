/** `generateText` — `streamText`, drained into one result. */

import { assembleMessage, messageText, type FinishReason, type UIMessage, type Usage } from '../protocol/index.js';
import { streamText, type StreamTextOptions } from './stream-text.js';

export interface GenerateTextResult {
    readonly text: string;
    readonly reasoning: string;
    readonly message: UIMessage;
    readonly finishReason: FinishReason;
    readonly usage?: Usage;
    readonly toolCalls: readonly { id: string; name: string; input: unknown; output?: unknown; isError?: boolean }[];
}

/** `streamText`, drained. Throws on an `error` chunk. */
export async function generateText(options: StreamTextOptions): Promise<GenerateTextResult> {
    const { message, last } = await assembleMessage(streamText(options));
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
        toolCalls
    };
}
