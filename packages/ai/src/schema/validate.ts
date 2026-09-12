/** Running a Standard Schema, and reading the JSON Schema it can render. */

import type { JsonSchema, StandardSchemaV1 } from './standard-schema.js';

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
