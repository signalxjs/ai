/**
 * The UI protocol — what crosses the wire from a `serverStream` handler to
 * `useChat`, and what a transcript is made of.
 *
 * Everything here is plain JSON: no classes, no functions, no `undefined`
 * semantics that NDJSON would lose. `@sigx/serialize` revives Dates and
 * friends on the boundary; nothing in this protocol needs it.
 */

// ── Transcript ──────────────────────────────────────────────────────────────

export type UIRole = 'user' | 'assistant';

/** A message as the UI holds it: parts, in the order the model produced them. */
export interface UIMessage {
    readonly id: string;
    readonly role: UIRole;
    parts: UIPart[];
    /** Epoch millis; optional so a hand-built message needs no clock. */
    createdAt?: number;
}

export type UIPart = UITextPart | UIReasoningPart | UIToolPart;

export interface UITextPart {
    readonly type: 'text';
    text: string;
}

export interface UIReasoningPart {
    readonly type: 'reasoning';
    text: string;
    /**
     * Provider-owned replay data (a signed thinking block, say). Opaque to the
     * UI; the provider that produced it reads it back when the transcript is
     * sent again on the same model.
     */
    providerData?: unknown;
}

export type UIToolState = 'pending' | 'done' | 'error';

/** One tool call and, once it has run, its result — a single part, in place. */
export interface UIToolPart {
    readonly type: 'tool';
    readonly id: string;
    readonly name: string;
    input: unknown;
    state: UIToolState;
    output?: unknown;
}

// ── Stream chunks ───────────────────────────────────────────────────────────

export type FinishReason = 'stop' | 'length' | 'tool' | 'refusal' | 'error' | 'other';

export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    /** Provider-specific extras (cache reads, reasoning tokens, …). */
    [key: string]: number | undefined;
}

/**
 * One chunk of a streaming assistant turn. A turn is:
 *
 *   start → (text | reasoning | tool-call | tool-result)* → finish
 *
 * `error` may appear anywhere and ends the turn. `finish` carries the
 * reason and, when the provider reports it, the usage for the whole turn
 * (every model round in a tool loop summed).
 */
export type UIChunk =
    | { readonly type: 'start'; readonly messageId: string }
    | { readonly type: 'text'; readonly delta: string }
    | { readonly type: 'reasoning'; readonly delta: string }
    | { readonly type: 'reasoning-end'; readonly providerData?: unknown }
    | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly input: unknown }
    | { readonly type: 'tool-result'; readonly id: string; readonly output: unknown; readonly isError?: boolean }
    | { readonly type: 'finish'; readonly reason: FinishReason; readonly usage?: Usage }
    | { readonly type: 'error'; readonly message: string };

/** Minimal shape check — enough to route a chunk, never a validator. */
export function isUIChunk(value: unknown): value is UIChunk {
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

// ── Ids ─────────────────────────────────────────────────────────────────────

let counter = 0;

/**
 * A message/tool-call id: `crypto.randomUUID()` where it exists (every
 * WinterCG runtime and every browser this package targets), a counter
 * otherwise (older happy-dom, exotic embedders). Uniqueness within one
 * page or one request is all the protocol needs.
 */
export function generateId(prefix = 'msg'): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID().slice(0, 12)}`;
    return `${prefix}_${Date.now().toString(36)}_${(++counter).toString(36)}`;
}

/** A fresh, empty message of the given role. */
export function createMessage(role: UIRole, parts: UIPart[] = [], id = generateId()): UIMessage {
    return { id, role, parts, createdAt: Date.now() };
}

/** The user message for a plain string. */
export function userMessage(text: string, id?: string): UIMessage {
    return createMessage('user', [{ type: 'text', text }], id);
}

/** All text parts of a message joined — what "the reply" reads as. */
export function messageText(message: UIMessage): string {
    let out = '';
    for (const part of message.parts) if (part.type === 'text') out += part.text;
    return out;
}
