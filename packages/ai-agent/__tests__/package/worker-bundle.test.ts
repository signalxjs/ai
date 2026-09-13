/**
 * The edge promise, end to end: bundle every entry the package exports for a
 * worker-like target with `@sigx/ai` inlined, and check the output neither
 * references Node globals nor fails to evaluate.
 *
 * The entries come from `package.json` `exports`, so a new entry is covered
 * the day it is declared. Every entry is evaluated as a module except `app`,
 * whose only imports beyond this package are the sigx runtime
 * (`@sigx/reactivity`, `@sigx/runtime-core`): those are peers a host app
 * supplies, not something this bundle may inline, so they stay external and a
 * `data:` module cannot resolve them — `app` is text-checked only. The
 * `src/`-wide scan in `edge-safety.test.ts` still covers its source.
 */
import { describe, it, expect } from 'vitest';
import { build, type Rollup } from 'vite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

/** A root-level export that must exist once the bundle evaluates — proof the entry is real, not empty. */
const PROBES: Record<string, readonly string[]> = {
    index: ['modelAgent', 'agentTool', 'createEventLog'],
    harness: ['createJsonRpcPeer', 'createMcpToolHandler'],
    testing: ['mockAgent', 'agentConformance'],
    coding: ['codingExtension'],
    wire: ['serveSession', 'connectSession']
};

/** Peers a host supplies; never inlined, never evaluable from a `data:` URL. */
const HOST_PEERS: Record<string, readonly string[]> = {
    app: ['@sigx/reactivity', '@sigx/runtime-core']
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
const entries = Object.keys(pkg.exports).map((subpath) => (subpath === '.' ? 'index' : subpath.slice(2)));

async function bundle(entry: string): Promise<string> {
    const file = entry === 'index' ? join(root, 'src', 'index.ts') : join(root, 'src', entry, 'index.ts');
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
            lib: { entry: file, formats: ['es'], fileName: () => `${entry}.js` },
            rollupOptions: { external: [...(HOST_PEERS[entry] ?? [])] }
        }
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    const outputs = Array.isArray(result) ? result : [result];
    return outputs.flatMap((o) => o.output).map((c) => ('code' in c ? c.code : '')).join('\n');
}

describe('@sigx/ai-agent worker bundle', () => {
    it('covers every declared entry', () => {
        expect(entries.sort()).toEqual(['app', 'coding', 'harness', 'index', 'testing', 'wire']);
        for (const entry of entries) expect(entry in PROBES || entry in HOST_PEERS, `entry "${entry}" needs a probe or a host-peer list`).toBe(true);
    });

    it.each(entries)('"%s" bundles for a worker with no process, Buffer, node: or require()', async (entry) => {
        const code = await bundle(entry);
        expect(code.length).toBeGreaterThan(500);
        // Prose in doc comments may say "process"; the code must not.
        const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*/gm, ' ');
        expect(codeOnly).not.toMatch(/\bprocess\b/);
        expect(codeOnly).not.toMatch(/\bBuffer\b/);
        expect(codeOnly).not.toMatch(/["']node:/);
        expect(codeOnly).not.toMatch(/\brequire\(/);
        const peers = HOST_PEERS[entry];
        if (peers) {
            // Text-checked only (see the header); the peers must be the only imports left.
            const imports = [...codeOnly.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
            expect(new Set(imports)).toEqual(new Set(peers));
            return;
        }
        // It evaluates as a module and exposes its surface.
        const mod = (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)) as Record<string, unknown>;
        for (const name of PROBES[entry]!) expect(typeof mod[name], `${entry} exports ${name}`).toBe('function');
    }, 90_000);
});
