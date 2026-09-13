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

import { type JsonSchema, type StandardSchemaV1, jsonSchemaOf, validateWith } from '../schema/index.js';
import type { ToolSpec } from '../model/index.js';

export interface ToolContext {
    /** Fires when the turn is aborted (client disconnect, `stop()`). */
    readonly signal: AbortSignal;
    /** The id of this call — for logs and idempotency keys. */
    readonly toolCallId: string;
}

/**
 * What a tool does to the world — hints a policy can decide on without
 * knowing the tool (`allowReadOnly`, say). Advisory; the tool's own
 * `needsApproval` is what the engine enforces.
 */
export interface ToolAnnotations {
    /** Reads only; never changes anything. */
    readonly readOnly?: boolean;
    /** May destroy or overwrite data. */
    readonly destructive?: boolean;
    /** Calling it twice with the same input has the same effect as once. */
    readonly idempotent?: boolean;
    /** Reaches outside the app (network, third parties). */
    readonly openWorld?: boolean;
}

export interface ToolOptions<S extends StandardSchemaV1, O> {
    readonly name: string;
    readonly description: string;
    readonly input: S;
    /** Explicit wire schema; overrides the one derived from `input`. */
    readonly jsonSchema?: JsonSchema;
    /** Ask the provider for schema-guaranteed arguments (Anthropic `strict`, OpenAI `strict`). */
    readonly strict?: boolean;
    /**
     * Ask before running — always, or per call (the predicate sees the
     * validated input). The engine then consults `onToolApproval`; with no
     * handler the call is denied, never silently run.
     */
    readonly needsApproval?: boolean | ((input: StandardSchemaV1.InferOutput<S>, ctx: ToolContext) => boolean | Promise<boolean>);
    readonly annotations?: ToolAnnotations;
    readonly execute: (input: StandardSchemaV1.InferOutput<S>, ctx: ToolContext) => O | Promise<O>;
}

export interface Tool<S extends StandardSchemaV1 = StandardSchemaV1, O = unknown> {
    readonly name: string;
    readonly description: string;
    readonly input: S;
    /** The provider-facing description — resolved once at definition. */
    readonly spec: ToolSpec;
    readonly annotations?: ToolAnnotations;
    /**
     * Present when the tool has `needsApproval`: validates `raw`, then says
     * whether THIS call needs a human. Throws `SchemaValidationError` on bad arguments.
     */
    readonly approval?: (raw: unknown, ctx: ToolContext) => Promise<boolean>;
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
    readonly annotations?: ToolAnnotations;
    readonly approval?: (raw: unknown, ctx: ToolContext) => Promise<boolean>;
    run(raw: unknown, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends StandardSchemaV1, O>(options: ToolOptions<S, O>): Tool<S, O> {
    const { name, description, input, execute, needsApproval, annotations } = options;
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
    const validate = (raw: unknown) => validateWith(input, raw, `Invalid arguments for tool "${name}"`);
    // Both forms validate first, so bad arguments fail as a validation error
    // before any approval UX; a predicate then sees the validated input.
    // `false`/absent leaves `approval` off so the engine skips the phase.
    const approval =
        needsApproval === true
            ? async (raw: unknown) => {
                  await validate(raw);
                  return true;
              }
            : typeof needsApproval === 'function'
              ? async (raw: unknown, ctx: ToolContext) => needsApproval(await validate(raw), ctx)
              : undefined;
    return {
        name,
        description,
        input,
        spec,
        ...(annotations ? { annotations } : {}),
        ...(approval ? { approval } : {}),
        execute,
        async run(raw, ctx) {
            return execute(await validate(raw), ctx);
        }
    };
}

/** Look a tool up by the name the model used. */
export function findTool(tools: readonly AnyTool[] | undefined, name: string): AnyTool | undefined {
    if (!tools) return undefined;
    for (const t of tools) if (t.name === name) return t;
    return undefined;
}
