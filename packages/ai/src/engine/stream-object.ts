/** Structured output — `streamObject` and `generateObject`, on top of `streamText` with a JSON response format. */

import type { LanguageModel } from '../model/index.js';
import type { FinishReason, UIChunk, Usage } from '../protocol/index.js';
import { jsonSchemaOf, validateWith, type JsonSchema, type StandardSchemaV1 } from '../schema/index.js';
import { parsePartialJson } from '../utils/partial-json.js';
import { streamText, type StreamTextOptions } from './stream-text.js';

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
