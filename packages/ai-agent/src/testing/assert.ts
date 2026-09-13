/** Throwing assertions for the conformance suite — no test-runner import, so `./testing` loads under plain Node. */

import { jsonEqual } from '../utils/json.js';

export class ConformanceError extends Error {
    override readonly name = 'ConformanceError';
}

export function fail(message: string): never {
    throw new ConformanceError(message);
}

export function assert(condition: unknown, message: string): asserts condition {
    if (!condition) fail(message);
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
    if (!jsonEqual(actual, expected)) fail(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}
