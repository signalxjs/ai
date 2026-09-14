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

/** Image and file parts appear on user messages only; the assistant side stays text, reasoning and tools. */
export type UIPart = UITextPart | UIReasoningPart | UIToolPart | UIImagePart | UIFilePart;

export interface UITextPart {
    readonly type: 'text';
    text: string;
}

/**
 * An image the user attached: exactly one of `data` (standard base64 — see
 * `encodeBase64`) or `url`. Base64 keeps the part plain JSON; a provider
 * that only takes one form converts or rejects at request time.
 */
export interface UIImagePart {
    readonly type: 'image';
    /** An IANA media type, e.g. `image/png`. */
    readonly mediaType: string;
    readonly data?: string;
    readonly url?: string;
}

/** A file the user attached (a PDF, a text document): exactly one of `data` (base64) or `url`. */
export interface UIFilePart {
    readonly type: 'file';
    readonly mediaType: string;
    readonly data?: string;
    readonly url?: string;
    readonly filename?: string;
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
 * Where a tool call stands. `streaming`: the arguments are still arriving —
 * `input` is the best partial read of `inputText` so far, and the call has
 * not been made. `pending`: called, running or not yet decided.
 * `awaiting`: needs approval, undecided. `approved`: the client said run it —
 * only ever seen in a transcript sent back to the server, which runs the
 * call and settles it. `done` / `error`: ran. `denied`: refused; `output`
 * is the reason the model is told.
 */
export type UIToolState = 'streaming' | 'pending' | 'awaiting' | 'approved' | 'done' | 'error' | 'denied';

/** One tool call and, once it has run, its result — a single part, in place. */
export interface UIToolPart {
    readonly type: 'tool';
    readonly id: string;
    readonly name: string;
    /**
     * The call's arguments. While `state` is `streaming` this is the best
     * partial read of `inputText` so far and may be absent — nothing is
     * parseable from `{"city` — and it is never absent in any other state.
     */
    input?: unknown;
    state: UIToolState;
    output?: unknown;
    /**
     * The raw argument JSON as it arrives, while `state` is `streaming` — so a
     * UI can show the text even before it parses. Dropped once `tool-call`
     * lands with the assembled `input`.
     */
    inputText?: string;
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
