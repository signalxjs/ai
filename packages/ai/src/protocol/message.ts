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

/**
 * Where a tool call stands. `pending`: called, running or not yet decided.
 * `awaiting`: needs approval, undecided. `approved`: the client said run it —
 * only ever seen in a transcript sent back to the server, which runs the
 * call and settles it. `done` / `error`: ran. `denied`: refused; `output`
 * is the reason the model is told.
 */
export type UIToolState = 'pending' | 'awaiting' | 'approved' | 'done' | 'error' | 'denied';

/** One tool call and, once it has run, its result — a single part, in place. */
export interface UIToolPart {
    readonly type: 'tool';
    readonly id: string;
    readonly name: string;
    input: unknown;
    state: UIToolState;
    output?: unknown;
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
