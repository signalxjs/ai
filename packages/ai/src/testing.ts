/**
 * `@sigx/ai/testing` — `mockModel`, a scripted `LanguageModel`.
 *
 * Deterministic and dependency-free, so a test, a docs live-code block or a
 * CI job never needs a key. A reply is text (split into word tokens), or
 * tool calls, or reasoning, or an error, with optional per-token delay; a
 * script is a list of replies consumed one model round at a time, and
 * `respond` computes one from the request (to answer a tool result, say).
 * Every request is recorded on `requests` for assertions.
 */

import type { LanguageModel, ModelEvent, ModelRequest } from './model.js';
import type { FinishReason, Usage } from './protocol.js';

export interface MockReply {
    readonly text?: string;
    readonly reasoning?: string;
    readonly toolCalls?: readonly { readonly name: string; readonly input: unknown; readonly id?: string }[];
    readonly finishReason?: FinishReason;
    readonly usage?: Usage;
    /** Throw this instead of finishing — after any text already emitted. */
    readonly error?: string;
    /** Characters per text chunk; default splits on word boundaries. */
    readonly chunkSize?: number;
    /** Milliseconds between chunks; default 0 (one microtask turn). */
    readonly delayMs?: number;
}

export interface MockModelOptions {
    readonly modelId?: string;
    /** Replies, one per model round, in order. The last one repeats. */
    readonly script?: readonly MockReply[];
    /** Compute the reply for a round; wins over `script`. */
    readonly respond?: (request: ModelRequest, round: number) => MockReply;
}

export interface MockModel extends LanguageModel {
    /** Every request seen, in order. */
    readonly requests: ModelRequest[];
    /** Rounds served so far. */
    readonly rounds: number;
}

function* tokens(text: string, chunkSize: number | undefined): Generator<string> {
    if (chunkSize && chunkSize > 0) {
        for (let i = 0; i < text.length; i += chunkSize) yield text.slice(i, i + chunkSize);
        return;
    }
    for (const word of text.split(/(?<=\s)/)) if (word) yield word;
}

function tick(ms: number | undefined): Promise<void> {
    return ms && ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export function mockModel(options: MockModelOptions = {}): MockModel {
    const requests: ModelRequest[] = [];
    let rounds = 0;
    /** Per-instance, so two mocks in one test never interleave their generated ids. */
    let callSeq = 0;
    const script = options.script ?? [{ text: 'Hello from the mock model.' }];

    return {
        provider: 'mock',
        modelId: options.modelId ?? 'mock-1',
        requests,
        get rounds() {
            return rounds;
        },
        async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
            requests.push(request);
            const round = rounds++;
            const reply = options.respond ? options.respond(request, round) : script[Math.min(round, script.length - 1)]!;
            const signal = request.signal;

            if (reply.reasoning) {
                for (const t of tokens(reply.reasoning, reply.chunkSize)) {
                    await tick(reply.delayMs);
                    if (signal?.aborted) return;
                    yield { type: 'reasoning-delta', delta: t };
                }
                yield { type: 'reasoning-end' };
            }
            if (reply.text) {
                for (const t of tokens(reply.text, reply.chunkSize)) {
                    await tick(reply.delayMs);
                    if (signal?.aborted) return;
                    yield { type: 'text-delta', delta: t };
                }
            }
            if (reply.error !== undefined) {
                yield { type: 'error', error: new Error(reply.error) };
                return;
            }
            if (reply.toolCalls?.length) {
                for (const call of reply.toolCalls) {
                    await tick(reply.delayMs);
                    if (signal?.aborted) return;
                    yield { type: 'tool-call', id: call.id ?? `call_${++callSeq}`, name: call.name, input: call.input };
                }
                yield { type: 'finish', reason: reply.finishReason ?? 'tool', ...(reply.usage ? { usage: reply.usage } : {}) };
                return;
            }
            yield { type: 'finish', reason: reply.finishReason ?? 'stop', ...(reply.usage ? { usage: reply.usage } : {}) };
        }
    };
}
