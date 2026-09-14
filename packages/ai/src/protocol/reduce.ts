/**
 * The chunk reducer that both the engine (for `generateText`) and `useChat`
 * (for the live transcript) fold a stream through — one reducer, so a message
 * built on the server and one built in the browser from the same chunks are
 * identical.
 */

import { parsePartialJson } from '../utils/partial-json.js';
import { createMessage, type UIMessage, type UIToolPart } from './message.js';
import type { UIChunk } from './chunk.js';

/**
 * How much raw argument text a `streaming` tool part accumulates before it
 * stops growing. The reducer folds a stream it does not control — a faulty
 * or hostile server can send deltas for ever — and every delta re-reads the
 * whole text, so an uncapped part is both unbounded memory and quadratic
 * work. Past the cap the part keeps what it has and the deltas are dropped:
 * a *display* of arguments degrades, and the assembled `tool-call` settles
 * the part with the real input regardless. Matches `ChatInput`'s cap on tool
 * JSON, which is what a client may post such a part back under.
 */
const MAX_STREAMING_INPUT_TEXT = 100_000;

/**
 * The last tool part carrying `id`, or `undefined` — a call is opened,
 * settled and finished wherever it was announced. (Not the exported
 * `findTool`, which looks a *tool* up by name.)
 */
function toolPart(message: UIMessage, id: string): UIToolPart | undefined {
    const parts = message.parts;
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        if (p.type === 'tool' && p.id === id) return p;
    }
    return undefined;
}

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
        case 'tool-input': {
            // Arguments still arriving. `input` is re-read from the whole text
            // on every delta, so a UI bound to it sees the object fill in.
            const open = toolPart(message, chunk.id);
            if (!open) {
                const text = chunk.delta.slice(0, MAX_STREAMING_INPUT_TEXT);
                parts.push({ type: 'tool', id: chunk.id, name: chunk.name, input: parsePartialJson(text), state: 'streaming', inputText: text });
                return false;
            }
            // A delta for a call that already landed is stale — never reopen it.
            if (open.state !== 'streaming') return false;
            const soFar = open.inputText ?? '';
            // At the cap the part stops growing, and stops being re-read.
            if (soFar.length >= MAX_STREAMING_INPUT_TEXT) return false;
            open.inputText = (soFar + chunk.delta).slice(0, MAX_STREAMING_INPUT_TEXT);
            open.input = parsePartialJson(open.inputText);
            return false;
        }
        case 'tool-call': {
            // The assembled call settles the part the deltas opened, in place,
            // so the UI keeps one chip rather than gaining a second.
            const open = toolPart(message, chunk.id);
            if (open && open.state === 'streaming') {
                open.input = chunk.input;
                open.state = 'pending';
                delete open.inputText;
                return false;
            }
            parts.push({ type: 'tool', id: chunk.id, name: chunk.name, input: chunk.input, state: 'pending' });
            return false;
        }
        case 'tool-approval-request': {
            const p = toolPart(message, chunk.id);
            // A request re-sent for a call the client already settled
            // (a resumed turn) never reopens it.
            if (p && (p.state === 'pending' || p.state === 'awaiting')) p.state = 'awaiting';
            return false;
        }
        case 'tool-result': {
            const p = toolPart(message, chunk.id);
            if (p) {
                p.output = chunk.output;
                p.state = chunk.denied ? 'denied' : chunk.isError ? 'error' : 'done';
            }
            return false;
        }
        case 'finish':
        case 'error':
            return true;
    }
}

/**
 * Drain a chunk stream into an assistant message — a fresh one, or `into`
 * when the stream's `start` announces its id (a resumed turn continues the
 * message it stopped on; see `streamText`).
 */
export async function assembleMessage(chunks: AsyncIterable<UIChunk>, into?: UIMessage): Promise<{ message: UIMessage; last: UIChunk | undefined }> {
    let message: UIMessage | undefined;
    let last: UIChunk | undefined;
    for await (const chunk of chunks) {
        last = chunk;
        if (chunk.type === 'start') {
            message = into && into.id === chunk.messageId ? into : createMessage('assistant', [], chunk.messageId);
            continue;
        }
        message ??= createMessage('assistant');
        // A terminal chunk ends the turn; anything a faulty source yields
        // after it is not part of this message.
        if (applyChunk(message, chunk)) break;
    }
    return { message: message ?? createMessage('assistant'), last };
}
