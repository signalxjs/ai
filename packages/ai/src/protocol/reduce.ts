/**
 * The chunk reducer that both the engine (for `generateText`) and `useChat`
 * (for the live transcript) fold a stream through — one reducer, so a message
 * built on the server and one built in the browser from the same chunks are
 * identical.
 */

import { createMessage, type UIMessage } from './message.js';
import type { UIChunk } from './chunk.js';

/**
 * Fold chunks into a message IN PLACE. Works on a plain object and on a
 * reactive proxy alike — `useChat` hands it the proxied message so a text
 * delta is one property write on one part.
 *
 * Returns `true` when the chunk ended the turn (`finish` / `error`).
 */
export function applyChunk(message: UIMessage, chunk: UIChunk): boolean {
    const parts = message.parts;
    const last = parts.length ? parts[parts.length - 1] : undefined;
    switch (chunk.type) {
        case 'start':
            // Adopt the id the server announced, so a message created client-side
            // as a placeholder (useChat) carries the same id as the server's copy.
            if (message.id !== chunk.messageId) (message as { id: string }).id = chunk.messageId;
            return false;
        case 'text':
            if (last && last.type === 'text') last.text += chunk.delta;
            else parts.push({ type: 'text', text: chunk.delta });
            return false;
        case 'reasoning':
            if (last && last.type === 'reasoning' && last.providerData === undefined) last.text += chunk.delta;
            else parts.push({ type: 'reasoning', text: chunk.delta });
            return false;
        case 'reasoning-end':
            if (chunk.providerData === undefined) return false;
            // Replay data closes the open reasoning part; with no open part (a
            // redacted block arrives as `reasoning-end` alone) it becomes its
            // own text-less part — the same shape the engine assembles server-side.
            if (last && last.type === 'reasoning' && last.providerData === undefined) last.providerData = chunk.providerData;
            else parts.push({ type: 'reasoning', text: '', providerData: chunk.providerData });
            return false;
        case 'tool-call':
            parts.push({ type: 'tool', id: chunk.id, name: chunk.name, input: chunk.input, state: 'pending' });
            return false;
        case 'tool-approval-request': {
            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i]!;
                if (p.type === 'tool' && p.id === chunk.id) {
                    // A request re-sent for a call the client already settled
                    // (a resumed turn) never reopens it.
                    if (p.state === 'pending' || p.state === 'awaiting') p.state = 'awaiting';
                    break;
                }
            }
            return false;
        }
        case 'tool-result': {
            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i]!;
                if (p.type === 'tool' && p.id === chunk.id) {
                    p.output = chunk.output;
                    p.state = chunk.denied ? 'denied' : chunk.isError ? 'error' : 'done';
                    break;
                }
            }
            return false;
        }
        case 'finish':
        case 'error':
            return true;
    }
}

/** Drain a chunk stream into a fresh assistant message. */
export async function assembleMessage(chunks: AsyncIterable<UIChunk>): Promise<{ message: UIMessage; last: UIChunk | undefined }> {
    let message: UIMessage | undefined;
    let last: UIChunk | undefined;
    for await (const chunk of chunks) {
        last = chunk;
        if (chunk.type === 'start') {
            message = createMessage('assistant', [], chunk.messageId);
            continue;
        }
        message ??= createMessage('assistant');
        // A terminal chunk ends the turn; anything a faulty source yields
        // after it is not part of this message.
        if (applyChunk(message, chunk)) break;
    }
    return { message: message ?? createMessage('assistant'), last };
}
