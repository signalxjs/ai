/**
 * The stream half of the UI protocol — one chunk per event of a streaming
 * assistant turn, and what a turn ends with.
 */

export type FinishReason = 'stop' | 'length' | 'tool' | 'refusal' | 'error' | 'other';

/**
 * Token counts for a turn. `inputTokens` and `outputTokens` are the two every
 * provider reports; the index signature carries whatever else one does.
 *
 * Extra keys are open, but the ones below are **well-known conventions**: an
 * adapter that has the number reports it under this name, so a client can read
 * it without knowing which provider produced it.
 *
 * | Key | Means |
 * |---|---|
 * | `reasoningTokens` | of `outputTokens`, how many were reasoning/thinking — a BREAKDOWN, never an addition. Anthropic's `output_tokens_details.thinking_tokens`, OpenAI's `output_tokens_details.reasoning_tokens`, ACP's `thoughtTokens`, Codex's `reasoningOutputTokens`. A harness that redacts reasoning text (Claude Code) may stream it as it goes, so it doubles as the one neutral "still thinking" signal. |
 * | `cacheReadInputTokens` / `cacheCreationInputTokens` | prompt-cache reads and writes |
 * | `totalTokens` | the provider's own total, when it reports one |
 */
export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    /** Provider-specific extras (cache reads, reasoning tokens, …). */
    [key: string]: number | undefined;
}

/**
 * One chunk of a streaming assistant turn. A turn is:
 *
 *   start → (text | reasoning | reasoning-end | tool-call | tool-approval-request | tool-result)* → finish
 *
 * `error` may appear anywhere and ends the turn. `finish` carries the
 * reason and, when the provider reports it, the usage for the whole turn
 * (every model round in a tool loop summed) — and `output`, the validated
 * structured result, when the turn asked for one (`streamText`'s `output`).
 *
 * `tool-approval-request` says a call needs a human before it runs; the
 * answer arrives as its `tool-result` — `denied: true` (with the reason as
 * `output`) when it was refused — or never, when the turn ends with
 * `finish { reason: 'tool' }` and the client is expected to decide and send
 * the transcript again (see `useChat.approve` / `deny`).
 */
export type UIChunk =
    | { readonly type: 'start'; readonly messageId: string }
    | { readonly type: 'text'; readonly delta: string }
    | { readonly type: 'reasoning'; readonly delta: string }
    | { readonly type: 'reasoning-end'; readonly providerData?: unknown }
    | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly input: unknown }
    | { readonly type: 'tool-approval-request'; readonly id: string }
    | { readonly type: 'tool-result'; readonly id: string; readonly output: unknown; readonly isError?: boolean; readonly denied?: true }
    | { readonly type: 'finish'; readonly reason: FinishReason; readonly usage?: Usage; readonly output?: unknown }
    | { readonly type: 'error'; readonly message: string };

/** Minimal shape check — enough to route a chunk, never a validator. */
export function isUIChunk(value: unknown): value is UIChunk {
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
