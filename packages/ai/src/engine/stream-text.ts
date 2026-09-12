/**
 * The engine — `streamText`, `generateText`, `streamObject`, `generateObject`.
 *
 * One model round is `model.stream(request)`. A TURN is one or more rounds:
 * when a round ends with tool calls, the engine runs every tool (in
 * parallel — one result message per round, the shape every provider trains
 * on), appends the assistant round and the results to the conversation, and
 * asks the model again, up to `maxSteps`. Everything the UI needs arrives
 * as `UIChunk`s, in order, on one async iterable.
 *
 * Abort is cooperative and total: `signal` reaches the provider (it aborts
 * the HTTP stream) and every tool (`ctx.signal`), and a consumer that
 * `break`s out of the iterable closes the provider stream through the
 * generator's `finally`.
 */

import { addUsage, toModelMessages, type LanguageModel, type ModelEvent, type ModelMessage, type ModelRequest } from '../model/index.js';
import { generateId, type FinishReason, type UIChunk, type UIMessage, type Usage } from '../protocol/index.js';
import { findTool, type AnyTool } from '../tool/index.js';
import { abortable, abortError, isAbort } from './abort.js';
import { toWireValue } from './wire-value.js';

export interface StreamTextOptions {
    readonly model: LanguageModel;
    readonly system?: string;
    /** A UI transcript or already-converted model messages. */
    readonly messages: readonly UIMessage[] | readonly ModelMessage[];
    readonly tools?: readonly AnyTool[];
    /** Model rounds per turn (1 = no tool loop). Default 5. */
    readonly maxSteps?: number;
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly signal?: AbortSignal;
    readonly providerOptions?: Readonly<Record<string, unknown>>;
    /** The id the `start` chunk announces; generated when omitted. */
    readonly messageId?: string;
    /** Observe each model round as it finishes (usage accounting, logging). */
    readonly onStep?: (step: StepInfo) => void;
}

export interface StepInfo {
    readonly step: number;
    readonly finishReason: FinishReason;
    readonly usage?: Usage;
    readonly toolCalls: readonly { id: string; name: string; input: unknown }[];
}

function isUIMessages(messages: readonly UIMessage[] | readonly ModelMessage[]): messages is readonly UIMessage[] {
    // An empty transcript converts to an empty model conversation either way;
    // treating it as UI keeps every first-turn flow on the same path.
    const first = messages[0];
    return first === undefined || 'parts' in first;
}

/** A single model round, translated to UI chunks; returns what the loop needs. */
async function* runRound(
    model: LanguageModel,
    request: ModelRequest
): AsyncGenerator<UIChunk, RoundResult> {
    const content: ModelMessage & { role: 'assistant' } = { role: 'assistant', content: [] };
    const parts = content.content as Array<
        { type: 'text'; text: string } | { type: 'reasoning'; text: string; providerData?: unknown } | { type: 'tool-call'; id: string; name: string; input: unknown }
    >;
    const toolCalls: { id: string; name: string; input: unknown }[] = [];
    let finish: FinishReason = 'other';
    let usage: Usage | undefined;
    let errored: unknown;
    let sawFinish = false;

    const iterable = model.stream(request);
    const iterator = iterable[Symbol.asyncIterator]();
    try {
        for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            const ev: ModelEvent = next.value;
            switch (ev.type) {
                case 'text-delta': {
                    const last = parts[parts.length - 1];
                    if (last && last.type === 'text') last.text += ev.delta;
                    else parts.push({ type: 'text', text: ev.delta });
                    yield { type: 'text', delta: ev.delta };
                    break;
                }
                case 'reasoning-delta': {
                    const last = parts[parts.length - 1];
                    if (last && last.type === 'reasoning' && last.providerData === undefined) last.text += ev.delta;
                    else parts.push({ type: 'reasoning', text: ev.delta });
                    yield { type: 'reasoning', delta: ev.delta };
                    break;
                }
                case 'reasoning-end': {
                    const last = parts[parts.length - 1];
                    if (last && last.type === 'reasoning') {
                        if (ev.providerData !== undefined) last.providerData = ev.providerData;
                    } else if (ev.providerData !== undefined) {
                        // A provider that reports reasoning only as replay data (no text).
                        parts.push({ type: 'reasoning', text: '', providerData: ev.providerData });
                    }
                    yield ev.providerData !== undefined ? { type: 'reasoning-end', providerData: ev.providerData } : { type: 'reasoning-end' };
                    break;
                }
                case 'tool-input-delta':
                    // Progressive argument display is a later UI feature; the
                    // engine waits for the assembled call.
                    break;
                case 'tool-call':
                    parts.push({ type: 'tool-call', id: ev.id, name: ev.name, input: ev.input });
                    toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
                    yield { type: 'tool-call', id: ev.id, name: ev.name, input: ev.input };
                    break;
                case 'finish':
                    sawFinish = true;
                    finish = ev.reason;
                    usage = ev.usage;
                    break;
                case 'error':
                    errored = ev.error;
                    break;
            }
            if (errored !== undefined || sawFinish) break;
        }
    } finally {
        // Always close the provider iterator: a consumer that stopped early
        // releases the stream, and a generator paused on its `finish` yield
        // runs its cleanup now rather than never. Closing a finished
        // iterator is a no-op.
        await iterator.return?.();
    }
    if (errored !== undefined) throw errored instanceof Error ? errored : new Error(String(errored));
    if (toolCalls.length && finish !== 'tool') finish = 'tool';
    return { assistant: content, toolCalls, finish, usage };
}

interface RoundResult {
    readonly assistant: ModelMessage & { role: 'assistant' };
    readonly toolCalls: readonly { id: string; name: string; input: unknown }[];
    readonly finish: FinishReason;
    readonly usage: Usage | undefined;
}

/**
 * Stream one assistant turn as UI chunks. Runs the tool loop; ends with
 * exactly one `finish` (or one `error`).
 */
export async function* streamText(options: StreamTextOptions): AsyncGenerator<UIChunk, void, undefined> {
    const { model, tools, signal } = options;
    // A finite integer ≥ 1; anything else (NaN, Infinity, a fraction) falls
    // back to the default rather than producing a loop that never runs.
    const maxSteps = Number.isFinite(options.maxSteps) ? Math.max(1, Math.floor(options.maxSteps as number)) : 5;
    const messages: ModelMessage[] = isUIMessages(options.messages)
        ? toModelMessages(options.messages)
        : [...(options.messages as readonly ModelMessage[])];
    const specs = tools?.length ? tools.map((t) => t.spec) : undefined;
    // Tools always receive a signal; without a caller's, one inert signal serves the whole turn.
    const toolSignal = signal ?? new AbortController().signal;
    let usage: Usage | undefined;
    let finish: FinishReason = 'other';

    yield { type: 'start', messageId: options.messageId ?? generateId() };

    try {
        for (let step = 1; step <= maxSteps; step++) {
            if (signal?.aborted) throw abortError(signal);
            const request: ModelRequest = {
                messages,
                ...(options.system !== undefined ? { system: options.system } : {}),
                ...(specs ? { tools: specs } : {}),
                ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
                ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                ...(signal ? { signal } : {}),
                ...(options.providerOptions ? { providerOptions: options.providerOptions } : {})
            };
            const round = yield* runRound(model, request);
            usage = addUsage(usage, round.usage);
            finish = round.finish;
            options.onStep?.({ step, finishReason: round.finish, usage: round.usage, toolCalls: round.toolCalls });

            if (!round.toolCalls.length) break;
            messages.push(round.assistant);

            if (step === maxSteps) {
                // Out of rounds with calls pending: report them unrun rather
                // than silently dropping the model's request.
                for (const call of round.toolCalls) {
                    yield { type: 'tool-result', id: call.id, output: `Tool "${call.name}" was not run: step limit (${maxSteps}) reached.`, isError: true };
                }
                finish = 'length';
                break;
            }

            // Every call of the round runs concurrently; results go back in ONE
            // message. An abort while they run ends the turn at once — the tools
            // hold `ctx.signal` and are expected to stop on their own.
            const results = await abortable(signal, Promise.all(
                round.toolCalls.map(async (call) => {
                    const tool = findTool(tools, call.name);
                    if (!tool) {
                        return { call, output: `Unknown tool "${call.name}".`, isError: true };
                    }
                    try {
                        const output = await tool.run(call.input, { signal: toolSignal, toolCallId: call.id });
                        // The protocol is plain JSON: the result is normalized to
                        // its JSON form HERE, so an in-process consumer sees exactly
                        // what crosses the wire; a value that cannot serialize is a
                        // tool error now rather than a broken stream later.
                        const wire = toWireValue(output);
                        if (wire.error !== undefined) return { call, output: `Tool "${call.name}" returned a value that is not JSON-serializable: ${wire.error}`, isError: true };
                        return { call, output: wire.value, isError: false };
                    } catch (e) {
                        return { call, output: e instanceof Error ? e.message : String(e), isError: true };
                    }
                })
            ));
            if (signal?.aborted) throw abortError(signal);
            for (const r of results) {
                yield r.isError
                    ? { type: 'tool-result', id: r.call.id, output: r.output, isError: true }
                    : { type: 'tool-result', id: r.call.id, output: r.output };
            }
            messages.push({
                role: 'tool',
                content: results.map((r) => ({
                    type: 'tool-result',
                    toolCallId: r.call.id,
                    toolName: r.call.name,
                    output: r.output,
                    ...(r.isError ? { isError: true } : {})
                }))
            });
        }
    } catch (e) {
        if (isAbort(e)) {
            yield { type: 'finish', reason: 'other', ...(usage ? { usage } : {}) };
            return;
        }
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
    }
    yield { type: 'finish', reason: finish, ...(usage ? { usage } : {}) };
}
