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

import { streamText, type StreamTextOptions } from './engine.js';
import type { UIChunk, UIMessage, UIPart } from './protocol.js';
import type { StandardSchemaV1 } from './schema.js';

export type { StreamTextOptions } from './engine.js';

export interface ChatInput {
    readonly messages: UIMessage[];
}

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

// ── Wire validation ─────────────────────────────────────────────────────────

const MAX_MESSAGES = 500;
const MAX_TEXT = 200_000;
const MAX_TOOL_JSON = 100_000;
const JSON_CAP_MESSAGE = `must be JSON-serializable and at most ${MAX_TOOL_JSON} characters as JSON`;

/**
 * `true` when `value` serializes to JSON within the cap; `false` when it is
 * too large, throws on serialization (BigInt, a cycle), or has no JSON form
 * at all (a function, a symbol, `undefined` — `JSON.stringify` returns
 * `undefined` for those rather than throwing).
 */
function withinJsonCap(value: unknown): boolean {
    try {
        const s = JSON.stringify(value);
        return s !== undefined && s.length <= MAX_TOOL_JSON;
    } catch {
        return false;
    }
}

function issue(path: (string | number)[], message: string): StandardSchemaV1.Issue {
    return { message, path };
}

function checkPart(p: unknown, path: (string | number)[], issues: StandardSchemaV1.Issue[]): UIPart | undefined {
    if (typeof p !== 'object' || p === null) {
        issues.push(issue(path, 'part must be an object'));
        return undefined;
    }
    const part = p as Record<string, unknown>;
    switch (part.type) {
        case 'text':
        case 'reasoning': {
            if (typeof part.text !== 'string') {
                issues.push(issue([...path, 'text'], 'must be a string'));
                return undefined;
            }
            if (part.text.length > MAX_TEXT) {
                issues.push(issue([...path, 'text'], `longer than ${MAX_TEXT} characters`));
                return undefined;
            }
            if (part.type === 'text') return { type: 'text', text: part.text };
            // Replay data is forwarded into provider requests verbatim, so it
            // gets the same cap as a tool payload.
            if (part.providerData !== undefined && !withinJsonCap(part.providerData)) {
                issues.push(issue([...path, 'providerData'], JSON_CAP_MESSAGE));
                return undefined;
            }
            return { type: 'reasoning', text: part.text, ...(part.providerData !== undefined ? { providerData: part.providerData } : {}) };
        }
        case 'tool': {
            if (typeof part.id !== 'string' || typeof part.name !== 'string') {
                issues.push(issue(path, 'tool part needs string id and name'));
                return undefined;
            }
            const state = part.state;
            if (state !== 'pending' && state !== 'done' && state !== 'error') {
                issues.push(issue([...path, 'state'], 'must be pending, done or error'));
                return undefined;
            }
            // `input` is always present (JSON has no undefined), and a result
            // exists only once the call has run — a `pending` part's `output`
            // would be a caller-injected "result", so it is dropped. Both are
            // arbitrary JSON from the wire, so they are size-capped (and, as a
            // consequence of measuring them, proven serializable).
            const input = part.input === undefined ? null : part.input;
            if (!withinJsonCap(input)) {
                issues.push(issue([...path, 'input'], JSON_CAP_MESSAGE));
                return undefined;
            }
            const hasOutput = state !== 'pending' && part.output !== undefined;
            if (hasOutput && !withinJsonCap(part.output)) {
                issues.push(issue([...path, 'output'], JSON_CAP_MESSAGE));
                return undefined;
            }
            return { type: 'tool', id: part.id, name: part.name, input, state, ...(hasOutput ? { output: part.output } : {}) };
        }
        default:
            issues.push(issue([...path, 'type'], 'unknown part type'));
            return undefined;
    }
}

function checkMessage(m: unknown, path: (string | number)[], issues: StandardSchemaV1.Issue[]): UIMessage | undefined {
    if (typeof m !== 'object' || m === null) {
        issues.push(issue(path, 'message must be an object'));
        return undefined;
    }
    const msg = m as Record<string, unknown>;
    if (typeof msg.id !== 'string' || !msg.id) issues.push(issue([...path, 'id'], 'must be a non-empty string'));
    if (msg.role !== 'user' && msg.role !== 'assistant') issues.push(issue([...path, 'role'], 'must be user or assistant'));
    if (!Array.isArray(msg.parts)) {
        issues.push(issue([...path, 'parts'], 'must be an array'));
        return undefined;
    }
    const parts: UIPart[] = [];
    msg.parts.forEach((p, i) => {
        const part = checkPart(p, [...path, 'parts', i], issues);
        if (part) parts.push(part);
    });
    if (issues.length) return undefined;
    return {
        id: msg.id as string,
        role: msg.role as 'user' | 'assistant',
        parts,
        ...(typeof msg.createdAt === 'number' ? { createdAt: msg.createdAt } : {})
    };
}

/**
 * Standard Schema for `{ messages: UIMessage[] }`. Structural: shapes,
 * roles, part types, string sizes, a message-count cap. Not a semantic
 * check — a transcript that ends in an assistant message is legal input.
 */
export const ChatInput: StandardSchemaV1<ChatInput, ChatInput> = {
    '~standard': {
        version: 1,
        vendor: 'sigx-ai',
        validate(value: unknown) {
            const issues: StandardSchemaV1.Issue[] = [];
            if (typeof value !== 'object' || value === null) return { issues: [issue([], 'input must be an object')] };
            const messages = (value as { messages?: unknown }).messages;
            if (!Array.isArray(messages)) return { issues: [issue(['messages'], 'must be an array')] };
            if (messages.length > MAX_MESSAGES) return { issues: [issue(['messages'], `more than ${MAX_MESSAGES} messages`)] };
            const out: UIMessage[] = [];
            messages.forEach((m, i) => {
                const msg = checkMessage(m, ['messages', i], issues);
                if (msg) out.push(msg);
            });
            if (issues.length) return { issues };
            return { value: { messages: out } };
        }
    }
};
