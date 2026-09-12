/** UI transcript → model messages. */

import type { UIMessage, UIPart } from '../protocol/index.js';
import type { ModelAssistantMessage, ModelMessage, ModelToolResultPart } from './message.js';

/**
 * UI transcript → model messages. Tool parts split into the assistant's
 * `tool-call` and a following `tool` message carrying the results, which is
 * the shape every provider wants (results in ONE message per turn).
 */
export function toModelMessages(messages: readonly UIMessage[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const m of messages) {
        if (m.role === 'user') {
            const text = m.parts
                .filter((p): p is Extract<UIPart, { type: 'text' }> => p.type === 'text')
                .map((p) => p.text)
                .join('');
            out.push({ role: 'user', content: text });
            continue;
        }
        const content: ModelAssistantMessage['content'][number][] = [];
        const results: ModelToolResultPart[] = [];
        for (const p of m.parts) {
            if (p.type === 'text') {
                if (p.text) content.push({ type: 'text', text: p.text });
            } else if (p.type === 'reasoning') {
                content.push({ type: 'reasoning', text: p.text, ...(p.providerData !== undefined ? { providerData: p.providerData } : {}) });
            } else {
                content.push({ type: 'tool-call', id: p.id, name: p.name, input: p.input });
                if (p.state !== 'pending') {
                    results.push({
                        type: 'tool-result',
                        toolCallId: p.id,
                        toolName: p.name,
                        output: p.output,
                        ...(p.state === 'error' ? { isError: true } : {})
                    });
                }
            }
        }
        if (content.length) out.push({ role: 'assistant', content });
        if (results.length) out.push({ role: 'tool', content: results });
    }
    return out;
}
