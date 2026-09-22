// @vitest-environment node
/** This package is the family's Node-only one: it declares Node types and has no runtime dependencies. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

describe('@sigx/ai-agent-node package', () => {
    it('declares Node types and no runtime dependencies', () => {
        const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8').replace(/\/\/[^\n]*/g, '')) as { compilerOptions: { types?: string[] } };
        expect(tsconfig.compilerOptions.types).toEqual(['node']);
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; peerDependencies: Record<string, string> };
        expect(pkg.dependencies ?? {}).toEqual({});
        // The peer tracks the sibling's CURRENT version the way bump-version
        // writes it (`caretRange` in scripts/lib/ranges.mjs): `^X.0.0` from 1.0,
        // `^0.Y.0` below it. A literal failed at 0.2.0; `^<version>` failed at
        // 0.2.1, where a patch bump rightly leaves the range alone.
        const sibling = JSON.parse(readFileSync(join(root, '..', 'ai-agent', 'package.json'), 'utf8')) as { version: string };
        const [major, minor, patch] = sibling.version.split('.');
        const caret = major !== '0' ? `^${major}.0.0` : minor !== '0' ? `^0.${minor}.0` : `^0.0.${patch}`;
        expect(pkg.peerDependencies['@sigx/ai-agent']).toBe(caret);
    });
});
