/** Types for `ranges.mjs`, so TypeScript tests can check against the same range rules the release scripts use. */

export function isPackTimeSpecifier(spec: unknown): boolean;
export function caretRange(version: string): string;
export function satisfiesCaret(range: unknown, version: string): boolean;
export function assertInRepoRanges(manifests: ReadonlyArray<{ readonly name: string; readonly version: string; readonly [field: string]: unknown }>): void;
