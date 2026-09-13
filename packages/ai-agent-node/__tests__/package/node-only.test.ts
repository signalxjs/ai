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
        expect(pkg.peerDependencies['@sigx/ai-agent']).toBe('^0.1.0');
    });
});
