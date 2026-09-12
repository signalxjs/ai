/** Standard Schema (vendored) plus the two things this package does with one: validate, and derive JSON Schema. */

export type { StandardSchemaV1, JsonSchema } from './standard-schema.js';
export { SchemaValidationError, validateWith, jsonSchemaOf } from './validate.js';
