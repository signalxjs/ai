// @vitest-environment node
/** This package is the family's Node-only one: it declares Node types and has no runtime dependencies. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caretRange } from '../../../../scripts/lib/ranges.mjs';

const root = join(import.meta.dirname, '..', '..');

describe('@sigx/ai-agent-node package', () => {
    it('declares Node types and no runtime dependencies', () => {
        const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8').replace(/\/\/[^\n]*/g, '')) as { compilerOptions: { types?: string[] } };
        expect(tsconfig.compilerOptions.types).toEqual(['node']);
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; peerDependencies: Record<string, string> };
        expect(pkg.dependencies ?? {}).toEqual({});
        // The peer tracks the sibling's CURRENT version the way bump-version
        // writes it — the same `caretRange`, so a change to the range rule
        // moves this test with it. A literal failed at 0.2.0, `^<version>` at 0.2.1.
        const sibling = JSON.parse(readFileSync(join(root, '..', 'ai-agent', 'package.json'), 'utf8')) as { version: string };
        expect(pkg.peerDependencies['@sigx/ai-agent']).toBe(caretRange(sibling.version));
    });
});
