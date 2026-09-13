/**
 * The edge promise, end to end: bundle the package's root entry for a
 * worker-like target with `@sigx/ai` inlined, and check the output neither
 * references Node globals nor fails to evaluate.
 */
import { describe, it, expect } from 'vitest';
import { build, type Rollup } from 'vite';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

describe('@sigx/ai-agent worker bundle', () => {
    it('bundles for a worker with no process, Buffer, node: or require()', async () => {
        const result = (await build({
            configFile: false,
            logLevel: 'silent',
            root,
            define: { __DEV__: 'false' },
            resolve: { alias: { '@sigx/ai': join(root, '..', 'ai', 'src', 'index.ts') } },
            build: {
                write: false,
                minify: false,
                target: 'esnext',
                lib: { entry: join(root, 'src', 'index.ts'), formats: ['es'], fileName: () => 'index.js' },
                rollupOptions: { external: [] }
            }
        })) as Rollup.RollupOutput | Rollup.RollupOutput[];
        const outputs = Array.isArray(result) ? result : [result];
        const code = outputs.flatMap((o) => o.output).map((c) => ('code' in c ? c.code : '')).join('\n');
        expect(code.length).toBeGreaterThan(1000);
        // Prose in doc comments may say "process"; the code must not.
        const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*/gm, ' ');
        expect(codeOnly).not.toMatch(/\bprocess\b/);
        expect(codeOnly).not.toMatch(/\bBuffer\b/);
        expect(codeOnly).not.toMatch(/["']node:/);
        expect(codeOnly).not.toMatch(/\brequire\(/);
        // It evaluates as a module and exposes the agent.
        const mod = (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)) as Record<string, unknown>;
        expect(typeof mod.modelAgent).toBe('function');
        expect(typeof mod.agentTool).toBe('function');
        expect(typeof mod.createEventLog).toBe('function');
    }, 60_000);
});
