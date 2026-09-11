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

import { addUsage, type LanguageModel, type ModelEvent, type ModelMessage, type ModelRequest } from './model.js';
import { generateId, messageText, type FinishReason, type UIChunk, type UIMessage, type Usage } from './protocol.js';
import { assembleMessage, toModelMessages } from './messages.js';
import { findTool, type AnyTool } from './tool.js';
import { jsonSchemaOf, validateWith, type JsonSchema, type StandardSchemaV1 } from './schema.js';
import { parsePartialJson } from './partial-json.js';

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
        // A consumer that stopped early closes the provider stream too.
        if (!sawFinish && errored === undefined) await iterator.return?.();
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
    const maxSteps = Math.max(1, options.maxSteps ?? 5);
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

            // Every call of the round runs concurrently; results go back in ONE message.
            const results = await Promise.all(
                round.toolCalls.map(async (call) => {
                    const tool = findTool(tools, call.name);
                    if (!tool) {
                        return { call, output: `Unknown tool "${call.name}".`, isError: true };
                    }
                    try {
                        const output = await tool.run(call.input, { signal: toolSignal, toolCallId: call.id });
                        return { call, output, isError: false };
                    } catch (e) {
                        return { call, output: e instanceof Error ? e.message : String(e), isError: true };
                    }
                })
            );
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

function abortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) return reason;
    const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
    err.name = 'AbortError';
    return err;
}

function isAbort(e: unknown): boolean {
    return e instanceof Error && e.name === 'AbortError';
}

// ── Buffered variants ───────────────────────────────────────────────────────

export interface GenerateTextResult {
    readonly text: string;
    readonly reasoning: string;
    readonly message: UIMessage;
    readonly finishReason: FinishReason;
    readonly usage?: Usage;
    readonly toolCalls: readonly { id: string; name: string; input: unknown; output?: unknown; isError?: boolean }[];
}

/** `streamText`, drained. Throws on an `error` chunk. */
export async function generateText(options: StreamTextOptions): Promise<GenerateTextResult> {
    const { message, last } = await assembleMessage(streamText(options));
    if (last?.type === 'error') throw new Error(last.message);
    const finish = last?.type === 'finish' ? last : undefined;
    let reasoning = '';
    const toolCalls: { id: string; name: string; input: unknown; output?: unknown; isError?: boolean }[] = [];
    for (const p of message.parts) {
        if (p.type === 'reasoning') reasoning += p.text;
        else if (p.type === 'tool') toolCalls.push({ id: p.id, name: p.name, input: p.input, output: p.output, ...(p.state === 'error' ? { isError: true } : {}) });
    }
    return {
        text: messageText(message),
        reasoning,
        message,
        finishReason: finish?.reason ?? 'other',
        ...(finish?.usage ? { usage: finish.usage } : {}),
        toolCalls
    };
}

// ── Structured output ───────────────────────────────────────────────────────

export interface StreamObjectOptions<S extends StandardSchemaV1> extends Omit<StreamTextOptions, 'tools' | 'maxSteps'> {
    readonly schema: S;
    /** Explicit JSON Schema when the library cannot derive one. */
    readonly jsonSchema?: JsonSchema;
    readonly schemaName?: string;
}

export interface ObjectChunk<T> {
    readonly type: 'object';
    /** The best parse of the text so far — a growing partial of `T`. */
    readonly partial: Partial<T>;
}

/**
 * Stream a JSON document matching `schema`. Yields the raw `UIChunk`s (so the
 * wire stays one protocol) interleaved with `object` chunks carrying the
 * current partial parse — consumers that only want the object filter on
 * `type === 'object'`; `useObject` does exactly that.
 */
export async function* streamObject<S extends StandardSchemaV1>(
    options: StreamObjectOptions<S>
): AsyncGenerator<UIChunk | ObjectChunk<StandardSchemaV1.InferOutput<S>>, void, undefined> {
    const schema = options.jsonSchema ?? jsonSchemaOf(options.schema);
    if (!schema) {
        throw new Error('[sigx ai] streamObject: no JSON Schema for `schema` — pass `jsonSchema` or use a library with Standard JSON Schema support.');
    }
    const { schema: _s, jsonSchema: _j, schemaName, ...rest } = options;
    const model: LanguageModel = {
        provider: options.model.provider,
        modelId: options.model.modelId,
        stream: (req) => options.model.stream({ ...req, responseFormat: { type: 'json', schema, ...(schemaName ? { name: schemaName } : {}) } })
    };
    let text = '';
    let lastPartial: unknown;
    for await (const chunk of streamText({ ...rest, model, maxSteps: 1 })) {
        yield chunk;
        if (chunk.type === 'text') {
            text += chunk.delta;
            const partial = parsePartialJson(text);
            if (partial !== undefined && partial !== lastPartial) {
                lastPartial = partial;
                yield { type: 'object', partial: partial as Partial<StandardSchemaV1.InferOutput<S>> };
            }
        }
    }
}

export interface GenerateObjectResult<T> {
    readonly object: T;
    readonly finishReason: FinishReason;
    readonly usage?: Usage;
}

/** `streamObject`, drained and validated against `schema`. */
export async function generateObject<S extends StandardSchemaV1>(
    options: StreamObjectOptions<S>
): Promise<GenerateObjectResult<StandardSchemaV1.InferOutput<S>>> {
    let text = '';
    let finish: Extract<UIChunk, { type: 'finish' }> | undefined;
    for await (const chunk of streamObject(options)) {
        if (chunk.type === 'text') text += chunk.delta;
        else if (chunk.type === 'finish') finish = chunk;
        else if (chunk.type === 'error') throw new Error(chunk.message);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        raw = parsePartialJson(text);
        if (raw === undefined) throw new Error('[sigx ai] generateObject: the model returned no parseable JSON.');
    }
    const object = await validateWith(options.schema, raw, 'The model output did not match the schema');
    return { object, finishReason: finish?.reason ?? 'other', ...(finish?.usage ? { usage: finish.usage } : {}) };
}
