import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, ENTRIES, entryName, publishedPackages, productionBundles } from './packages.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const published = publishedPackages(rootDir);

test('entryName maps the root and subpaths', () => {
    assert.equal(entryName('@sigx/ai', '.'), '@sigx/ai');
    assert.equal(entryName('@sigx/ai', './app'), '@sigx/ai/app');
});

test('productionBundles reads only export conditions that name a production file', () => {
    const bundles = productionBundles('packages/x', {
        name: '@sigx/x',
        exports: {
            '.': { types: './dist/index.d.ts', production: './dist/index.prod.js', import: './dist/index.js' },
            './types': { types: './dist/types.d.ts' },
            './package.json': './package.json',
        },
    });
    assert.deepEqual(bundles, [{ name: '@sigx/x', path: 'packages/x/dist/index.prod.js' }]);
});

test('every published package is in PACKAGES, and PACKAGES names only published packages', () => {
    assert.ok(published.length > 0, 'found published packages under packages/');
    assert.deepEqual(new Set(PACKAGES), new Set(published.map((p) => p.dir)));
});

test('PACKAGES is in dependency order: a package never precedes one it depends on', () => {
    const byDir = new Map(published.map((p) => [p.dir, p.manifest]));
    const dirByName = new Map(published.map((p) => [p.manifest.name, p.dir]));
    for (let i = 0; i < PACKAGES.length; i++) {
        const manifest = byDir.get(PACKAGES[i]);
        const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
        for (const name of Object.keys(deps)) {
            const depDir = dirByName.get(name);
            if (!depDir) continue;
            assert.ok(PACKAGES.indexOf(depDir) < i, `${PACKAGES[i]} depends on ${name}, which must come first`);
        }
    }
});

test('every runtime export of every published package is in ENTRIES, and ENTRIES names only real exports', () => {
    const expected = new Set();
    for (const { manifest } of published) {
        for (const [subpath, condition] of Object.entries(manifest.exports ?? {})) {
            const runtime = typeof condition === 'object' && condition !== null && (condition.import || condition.default);
            if (runtime) expected.add(entryName(manifest.name, subpath));
        }
    }
    assert.deepEqual(new Set(ENTRIES), expected);
});

test('.size-limit.json has exactly one entry per production bundle, at its dist path', () => {
    const sizeLimit = JSON.parse(readFileSync(join(rootDir, '.size-limit.json'), 'utf-8'));
    const actual = new Map(sizeLimit.map((e) => [e.name, e.path]));
    assert.equal(actual.size, sizeLimit.length, '.size-limit.json names are unique');
    const expected = new Map();
    for (const { dir, manifest } of published) for (const b of productionBundles(dir, manifest)) expected.set(b.name, b.path);
    for (const [name, path] of expected) assert.equal(actual.get(name), path, `.size-limit.json entry for ${name}`);
    for (const name of actual.keys()) assert.ok(expected.has(name), `.size-limit.json entry "${name}" matches no published production bundle`);
});
