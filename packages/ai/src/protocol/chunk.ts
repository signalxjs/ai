/**
 * The stream half of the UI protocol — one chunk per event of a streaming
 * assistant turn, and what a turn ends with.
 */

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
