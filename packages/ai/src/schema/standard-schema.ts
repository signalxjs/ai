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
