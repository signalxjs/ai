#!/usr/bin/env node

/**
 * signalxjs/ai - Pre-publish pack smoke test
 *
 * Catches packaging bugs that lint/typecheck/test miss:
 *   - missing files in `files` array
 *   - broken `exports` map (every runtime subpath is imported)
 *   - dist/ produced by stale builds
 *   - a `workspace:` / `catalog:` range that survived into a tarball manifest
 *   - an in-repo peer/runtime range left behind by a version bump
 *
 * What it does:
 *   1. Build the packages (delegates to `pnpm run build`).
 *   2. `pnpm pack` every publishable package into a temp dir.
 *   3. Spin up a minimal scratch project with file: deps on the tarballs
 *      (plus the provider SDKs the provider packages peer on).
 *   4. `npm install` (pulls peer/runtime deps from the npm registry).
 *   5. `node` import-smoke every published entry point.
 *
 * Usage:
 *   node scripts/verify-pack.js
 *
 * No flags. Exits non-zero on any failure.
 */

import { execSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { assertInRepoRanges, isPackTimeSpecifier } from './lib/ranges.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const PACKAGES = ['packages/ai', 'packages/ai-agent', 'packages/ai-anthropic', 'packages/ai-openai'];

/** Every runtime entry the tarballs expose, imported one by one. */
const ENTRIES = [
    '@sigx/ai',
    '@sigx/ai/server',
    '@sigx/ai/app',
    '@sigx/ai/testing',
    '@sigx/ai-agent',
    '@sigx/ai-agent/testing',
    '@sigx/ai-agent/harness',
    '@sigx/ai-anthropic',
    '@sigx/ai-openai',
];

const sandbox = join(tmpdir(), `sigx-ai-verify-pack-${Date.now()}`);
const tarballDir = join(sandbox, 'tarballs');
const appDir = join(sandbox, 'app');

function run(cmd, opts = {}) {
    console.log(`$ ${cmd}${opts.cwd ? `  (in ${opts.cwd})` : ''}`);
    execSync(cmd, { stdio: 'inherit', ...opts });
}

function step(label) {
    console.log(`\n>  ${label}`);
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

function packPackage(pkgPath) {
    const pkgFullPath = join(rootDir, pkgPath);
    const pkgJson = readJson(join(pkgFullPath, 'package.json'));
    run('pnpm pack --pack-destination ' + JSON.stringify(tarballDir), { cwd: pkgFullPath });
    const tarballs = readdirSync(tarballDir).filter((f) => f.endsWith('.tgz'));
    const safeName = pkgJson.name.replace('@', '').replace('/', '-');
    const match = tarballs.find((f) => f.startsWith(safeName + '-'));
    if (!match) {
        throw new Error(`Could not find tarball for ${pkgJson.name} in ${tarballDir}`);
    }
    return { name: pkgJson.name, version: pkgJson.version, tarball: join(tarballDir, match) };
}

/**
 * A tarball manifest must carry concrete ranges. `workspace:` / `catalog:`
 * are rewritten by `pnpm pack` (the scratch install below fails loudly if
 * they were not); a literal in-repo range (`"@sigx/ai": "^0.1.0"`) is ours,
 * and must satisfy the sibling version being packed — otherwise the family
 * publishes as tarballs that cannot install together. `assertInRepoRanges`
 * throws on the first stale one.
 */
function assertConcreteRanges(manifests) {
    for (const pkg of manifests) {
        for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
            for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
                if (isPackTimeSpecifier(spec)) console.log(`   (${pkg.name} ${field}.${dep} = ${spec} — rewritten at pack time)`);
            }
        }
    }
    assertInRepoRanges(manifests);
}

function main() {
    step(`Sandbox: ${sandbox}`);
    mkdirSync(tarballDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });

    step('Build packages');
    run('pnpm run build', { cwd: rootDir });

    step('Pack publishable packages');
    assertConcreteRanges(PACKAGES.map((p) => readJson(join(rootDir, p, 'package.json'))));
    const packed = PACKAGES.map(packPackage);
    for (const p of packed) {
        console.log(`   ${p.name}@${p.version}  ->  ${p.tarball}`);
    }

    step('Create scratch app');
    const deps = Object.fromEntries(
        packed.map((p) => [p.name, `file:${p.tarball.replace(/\\/g, '/')}`])
    );
    const appPkg = {
        name: 'sigx-ai-pack-smoke',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { smoke: 'node smoke.mjs' },
        // The provider packages peer on their SDKs; the scratch app owns the copy,
        // exactly as a consuming app does.
        dependencies: { ...deps, '@anthropic-ai/sdk': '*', openai: '*' },
    };
    writeFileSync(join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2));

    writeFileSync(
        join(appDir, 'smoke.mjs'),
        [
            `const entries = ${JSON.stringify(ENTRIES)};`,
            'for (const entry of entries) {',
            '    const mod = await import(entry);',
            '    const keys = Object.keys(mod);',
            "    if (keys.length === 0) throw new Error(entry + ' exports no named bindings');",
            "    console.log('ok ' + entry + ':', keys.join(', '));",
            '}',
            '',
        ].join('\n')
    );

    step('Install scratch app (npm — to avoid pnpm workspace hoisting interference)');
    run('npm install --no-audit --no-fund --loglevel=error', { cwd: appDir });

    step('Run import smoke (dev condition)');
    run('npm run smoke --silent', { cwd: appDir });

    step('Run import smoke (production condition)');
    run('node --conditions production smoke.mjs', { cwd: appDir });

    step('Pack smoke test passed');
}

try {
    main();
} catch (err) {
    console.error('\nPack smoke test failed:', err.message);
    console.error(`   Sandbox preserved for inspection: ${sandbox}`);
    process.exitCode = 1;
    process.exit(1);
}

try {
    rmSync(sandbox, { recursive: true, force: true });
} catch {
    // ignore
}
