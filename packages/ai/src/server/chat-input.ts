/**
 * `ChatInput` — the wire schema for `{ messages: UIMessage[] }`. The
 * transcript is attacker-controlled, so it is checked structurally (shapes,
 * roles, part types, string sizes, a message-count cap) before the model
 * sees it. A dependency-free Standard Schema; bring your own (Zod, …) to add
 * fields.
 */

import { DENIED_MESSAGE } from '../model/index.js';
import type { UIMessage, UIPart, UIToolState } from '../protocol/index.js';
import type { StandardSchemaV1 } from '../schema/index.js';

export interface ChatInput {
    readonly messages: UIMessage[];
}

const TOOL_STATES: readonly UIToolState[] = ['pending', 'awaiting', 'approved', 'done', 'error', 'denied'];
const isToolState = (v: unknown): v is UIToolState => TOOL_STATES.includes(v as UIToolState);

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
            if (!isToolState(state)) {
                issues.push(issue([...path, 'state'], `must be ${TOOL_STATES.slice(0, -1).join(', ')} or ${TOOL_STATES[TOOL_STATES.length - 1]}`));
                return undefined;
            }
            // `input` is always present (JSON has no undefined), and a result
            // exists only once the call has settled — an undecided part's
            // `output` would be a caller-injected "result", so it is dropped.
            // Both are arbitrary JSON from the wire, so they are size-capped
            // (and, as a consequence of measuring them, proven serializable).
            const input = part.input === undefined ? null : part.input;
            if (!withinJsonCap(input)) {
                issues.push(issue([...path, 'input'], JSON_CAP_MESSAGE));
                return undefined;
            }
            // A settled call always has an output on the wire (the engine
            // normalizes `undefined` to `null`); a denial the client gave no
            // reason for gets the standard message the model is told.
            const settled = state === 'done' || state === 'error' || state === 'denied';
            const output = state === 'denied' && part.output === undefined ? DENIED_MESSAGE : part.output;
            if (settled && output === undefined) {
                issues.push(issue([...path, 'output'], 'required once the call has settled'));
                return undefined;
            }
            if (settled && !withinJsonCap(output)) {
                issues.push(issue([...path, 'output'], JSON_CAP_MESSAGE));
                return undefined;
            }
            return { type: 'tool', id: part.id, name: part.name, input, state, ...(settled ? { output } : {}) };
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
