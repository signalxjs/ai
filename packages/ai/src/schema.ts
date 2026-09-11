/**
 * Standard Schema (https://standardschema.dev) — the validator contract every
 * schema library implements (Zod, Valibot, ArkType, …), vendored as a type so
 * this package keeps zero dependencies. The same contract `@sigx/server`
 * accepts for `serverFn({ input })`, so one schema validates both the wire
 * input and a tool's arguments.
 *
 * The optional `jsonSchema` member is the Standard JSON Schema extension
 * (Zod 4.2+ implements it): the cheapest way for a tool to get its wire
 * schema without a second declaration.
 */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
    export interface Props<Input = unknown, Output = Input> {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
        readonly types?: Types<Input, Output> | undefined;
        /** Standard JSON Schema — present when the library can render one. */
        readonly jsonSchema?: JsonSchemaConverter | undefined;
    }

    export interface JsonSchemaConverter {
        readonly input: (options: JsonSchemaOptions) => JsonSchema;
        readonly output: (options: JsonSchemaOptions) => JsonSchema;
    }

    export interface JsonSchemaOptions {
        readonly target: 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | (string & {});
    }

    export type Result<Output> = SuccessResult<Output> | FailureResult;

    export interface SuccessResult<Output> {
        readonly value: Output;
        readonly issues?: undefined;
    }

    export interface FailureResult {
        readonly issues: ReadonlyArray<Issue>;
    }

    export interface Issue {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
    }

    export interface PathSegment {
        readonly key: PropertyKey;
    }

    export interface Types<Input = unknown, Output = Input> {
        readonly input: Input;
        readonly output: Output;
    }

    export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];
    export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];
}

/** A JSON Schema document — kept structural; the providers only pass it through. */
export type JsonSchema = Record<string, unknown>;

/** The failure a rejected validation surfaces — `issues` verbatim from the schema. */
export class SchemaValidationError extends Error {
    override readonly name = 'SchemaValidationError';
    constructor(
        readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
        message = 'Invalid input'
    ) {
        super(`${message}: ${issues.map(formatIssue).join('; ')}`);
    }
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
    const path = issue.path?.map((p) => (typeof p === 'object' && p !== null && 'key' in p ? String(p.key) : String(p))).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
}

/** Run a Standard Schema; throws {@link SchemaValidationError} on rejection. */
export async function validateWith<S extends StandardSchemaV1>(
    schema: S,
    value: unknown,
    what = 'Invalid input'
): Promise<StandardSchemaV1.InferOutput<S>> {
    // Unconditional await: a sync result passes straight through, and a
    // cross-realm promise or a thenable is awaited too (an `instanceof
    // Promise` check would miss both).
    const result = await schema['~standard'].validate(value);
    if (result.issues) throw new SchemaValidationError(result.issues, what);
    return result.value as StandardSchemaV1.InferOutput<S>;
}

/**
 * The JSON Schema for a Standard Schema's INPUT, when the library can render
 * one (Standard JSON Schema). `undefined` otherwise — the caller decides
 * whether that is an error.
 */
export function jsonSchemaOf(schema: StandardSchemaV1): JsonSchema | undefined {
    const conv = schema['~standard'].jsonSchema;
    if (!conv) return undefined;
    try {
        return conv.input({ target: 'draft-2020-12' });
    } catch {
        return undefined;
    }
}
