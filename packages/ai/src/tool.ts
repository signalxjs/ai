/**
 * `defineTool` — a function the model may call.
 *
 * `input` is a Standard Schema (Zod/Valibot/ArkType — the same contract as
 * `serverFn({ input })`): it validates the model's arguments on every call,
 * so `execute` receives a typed, checked value. The wire schema the provider
 * advertises comes from `jsonSchema` when given, otherwise from the schema
 * library's Standard JSON Schema hook; a tool that has neither throws at
 * DEFINITION time, not on the first call in production.
 */

import { type JsonSchema, type StandardSchemaV1, jsonSchemaOf, validateWith } from './schema.js';
import type { ToolSpec } from './model.js';

export interface ToolContext {
    /** Fires when the turn is aborted (client disconnect, `stop()`). */
    readonly signal: AbortSignal;
    /** The id of this call — for logs and idempotency keys. */
    readonly toolCallId: string;
}

export interface ToolOptions<S extends StandardSchemaV1, O> {
    readonly name: string;
    readonly description: string;
    readonly input: S;
    /** Explicit wire schema; overrides the one derived from `input`. */
    readonly jsonSchema?: JsonSchema;
    /** Ask the provider for schema-guaranteed arguments (Anthropic `strict`, OpenAI `strict`). */
    readonly strict?: boolean;
    readonly execute: (input: StandardSchemaV1.InferOutput<S>, ctx: ToolContext) => O | Promise<O>;
}

export interface Tool<S extends StandardSchemaV1 = StandardSchemaV1, O = unknown> {
    readonly name: string;
    readonly description: string;
    readonly input: S;
    /** The provider-facing description — resolved once at definition. */
    readonly spec: ToolSpec;
    /** Validate `raw` against `input`, then run. Throws `SchemaValidationError` on bad arguments. */
    run(raw: unknown, ctx: ToolContext): Promise<O>;
    readonly execute: ToolOptions<S, O>['execute'];
}

/**
 * What the engine needs from a tool — the parts that do not vary with the
 * schema type, so a `Tool<S, O>` of any `S`/`O` is assignable (the typed
 * `execute` parameter would otherwise make it contravariant-incompatible).
 */
export interface AnyTool {
    readonly name: string;
    readonly description: string;
    readonly input: StandardSchemaV1;
    readonly spec: ToolSpec;
    run(raw: unknown, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends StandardSchemaV1, O>(options: ToolOptions<S, O>): Tool<S, O> {
    const { name, description, input, execute } = options;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        throw new Error(
            `[sigx ai] defineTool: "${name}" is not a valid tool name — providers accept ` +
                `letters, digits, "_" and "-", at most 64 characters.`
        );
    }
    const inputSchema = options.jsonSchema ?? jsonSchemaOf(input);
    if (!inputSchema) {
        throw new Error(
            `[sigx ai] defineTool "${name}": no JSON Schema for its input. Pass \`jsonSchema\` ` +
                `explicitly, or use a schema library that implements Standard JSON Schema ` +
                `(Zod 4.2+, for one) so it can be derived from \`input\`.`
        );
    }
    const spec: ToolSpec = {
        name,
        description,
        inputSchema,
        ...(options.strict !== undefined ? { strict: options.strict } : {})
    };
    return {
        name,
        description,
        input,
        spec,
        execute,
        async run(raw, ctx) {
            const value = await validateWith(input, raw, `Invalid arguments for tool "${name}"`);
            return execute(value, ctx);
        }
    };
}

/** Look a tool up by the name the model used. */
export function findTool(tools: readonly AnyTool[] | undefined, name: string): AnyTool | undefined {
    if (!tools) return undefined;
    for (const t of tools) if (t.name === name) return t;
    return undefined;
}
