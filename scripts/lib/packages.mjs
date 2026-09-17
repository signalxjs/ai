/**
 * The one list of what this repo publishes.
 *
 * `PACKAGES` is every published package directory in dependency order
 * (dependencies first — `publish.js` walks it top to bottom); `ENTRIES` is
 * every runtime entry the tarballs expose (`verify-pack.js` imports each one
 * from a scratch app). Both used to be hand-copied into each script; the
 * guard in `packages.test.mjs` now checks them against the `package.json`
 * files and `.size-limit.json`, so a new package or entry that misses one
 * place fails `pnpm test:scripts` instead of slipping through a release.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const PACKAGES = [
    'packages/json-ui',
    'packages/ai',
    'packages/ai-agent',
    'packages/ai-agent-node',
    'packages/ai-agent-acp',
    'packages/ai-agent-claude-code',
    'packages/ai-agent-codex-cli',
    'packages/ai-agent-copilot-cli',
    'packages/ai-anthropic',
    'packages/ai-openai',
];

export const ENTRIES = [
    '@sigx/ai',
    '@sigx/ai/server',
    '@sigx/ai/app',
    '@sigx/ai/testing',
    '@sigx/ai/ui',
    '@sigx/json-ui',
    '@sigx/json-ui/app',
    '@sigx/json-ui/web',
    '@sigx/ai-agent',
    '@sigx/ai-agent/testing',
    '@sigx/ai-agent/coding',
    '@sigx/ai-agent/harness',
    '@sigx/ai-agent/wire',
    '@sigx/ai-agent/app',
    '@sigx/ai-agent-node',
    '@sigx/ai-agent-acp',
    '@sigx/ai-agent-claude-code',
    '@sigx/ai-agent-codex-cli',
    '@sigx/ai-agent-copilot-cli',
    '@sigx/ai-anthropic',
    '@sigx/ai-openai',
];

/** `'.'` → `@scope/name`, `'./sub'` → `@scope/name/sub`. */
export function entryName(pkgName, subpath) {
    return subpath === '.' ? pkgName : `${pkgName}/${subpath.slice(2)}`;
}

/**
 * Every `packages/<dir>/package.json` that publishes to npm (not `private`,
 * `publishConfig.access: "public"`), as `{ dir, manifest }` with `dir`
 * relative to the repo root (`packages/<name>`).
 */
export function publishedPackages(rootDir) {
    const base = join(rootDir, 'packages');
    const out = [];
    for (const name of readdirSync(base).sort()) {
        const file = join(base, name, 'package.json');
        if (!existsSync(file)) continue;
        const manifest = JSON.parse(readFileSync(file, 'utf-8'));
        if (manifest.private || manifest.publishConfig?.access !== 'public') continue;
        out.push({ dir: `packages/${name}`, manifest });
    }
    return out;
}

/**
 * The production bundles a manifest's `exports` map promises, as the
 * `{ name, path }` pairs `.size-limit.json` must carry (path relative to the
 * repo root, forward slashes).
 */
export function productionBundles(dir, manifest) {
    const out = [];
    for (const [subpath, condition] of Object.entries(manifest.exports ?? {})) {
        const production = typeof condition === 'object' && condition !== null ? condition.production : undefined;
        if (typeof production !== 'string') continue;
        out.push({ name: entryName(manifest.name, subpath), path: `${dir}/${production.replace(/^\.\//, '')}` });
    }
    return out;
}
