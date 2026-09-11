import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    peerRangeFor,
    manifestProblems,
    alignManifest,
    isPublishable,
    SINGLETON_PACKAGES,
    PEER_EXEMPT,
    CORE_PACKAGES,
} from './core-deps.mjs';

test('the singleton and exempt sets partition the core list', () => {
    assert.equal(SINGLETON_PACKAGES.size + PEER_EXEMPT.size, CORE_PACKAGES.size);
    for (const name of PEER_EXEMPT) assert.ok(CORE_PACKAGES.has(name), `${name} is core`);
    for (const name of SINGLETON_PACKAGES) assert.ok(!PEER_EXEMPT.has(name), `${name} is not exempt`);
    assert.ok(SINGLETON_PACKAGES.has('sigx'));
    assert.ok(SINGLETON_PACKAGES.has('@sigx/reactivity'));
    assert.ok(PEER_EXEMPT.has('@sigx/serialize'));
    assert.ok(PEER_EXEMPT.has('@sigx/vite'));
});

test('peerRangeFor: 0.x keeps the single-minor pin, 1.x+ widens to the major, an rc of X.0.0 stays exact', () => {
    assert.equal(peerRangeFor('^0.15.0'), '^0.15.0');
    assert.equal(peerRangeFor('^1.0.0'), '^1.0.0');
    assert.equal(peerRangeFor('^1.3.0'), '^1.0.0');
    assert.equal(peerRangeFor('^2.7.0'), '^2.0.0');
    assert.equal(peerRangeFor('^1.0.0-rc.0'), '^1.0.0-rc.0');
    assert.equal(peerRangeFor('^1.1.0-beta.2'), '^1.0.0', 'a prerelease of a later minor is still inside ^1.0.0');
    assert.equal(peerRangeFor('>=0.11.0 <0.13.0'), null);
    assert.equal(peerRangeFor(undefined), null);
});

test('isPublishable: named and not private', () => {
    assert.equal(isPublishable({ name: '@acme/lib' }), true);
    assert.equal(isPublishable({ name: '@acme/app', private: true }), false);
    assert.equal(isPublishable({ private: true }), false);
    assert.equal(isPublishable({}), false);
});

test('a private manifest must use "catalog:" in every field, singletons included', () => {
    const app = {
        name: 'app',
        private: true,
        dependencies: { sigx: 'catalog:', '@sigx/router': '^0.5.0' },
        devDependencies: { '@sigx/vite': '^0.15.0' },
        peerDependencies: { '@sigx/reactivity': '^0.15.0' },
    };
    const problems = manifestProblems(app, '^0.15.0');
    assert.deepEqual(
        problems.map((p) => [p.kind, p.field, p.dep]),
        [
            ['inline', 'devDependencies', '@sigx/vite'],
            ['inline', 'peerDependencies', '@sigx/reactivity'],
        ],
    );
    // A sibling (not core) is never the guard's business.
    assert.ok(!problems.some((p) => p.dep === '@sigx/router'));
});

test('a publishable package: singleton in dependencies is a shape problem when "catalog:", inline otherwise', () => {
    const lib = {
        name: '@acme/lib',
        dependencies: { '@sigx/reactivity': 'catalog:', '@sigx/runtime-core': '^0.15.0', '@sigx/serialize': 'catalog:' },
    };
    const problems = manifestProblems(lib, '^1.0.0');
    assert.deepEqual(
        problems.map((p) => [p.kind, p.field, p.dep]),
        [
            ['shape', 'dependencies', '@sigx/reactivity'],
            ['inline', 'dependencies', '@sigx/runtime-core'],
        ],
    );
    assert.match(problems[0].must, /peerDependencies "\^1\.0\.0" \+ devDependencies "catalog:"/);
    // The exempt leaf stays a plain "catalog:" dependency.
    assert.ok(!problems.some((p) => p.dep === '@sigx/serialize'));
});

test('a publishable package: a peer at the wrong range, or without its dev twin, is a shape problem', () => {
    const lib = {
        name: '@acme/lib',
        peerDependencies: { sigx: '^0.15.0', '@sigx/cache': '^1.0.0' },
        devDependencies: { sigx: 'catalog:' },
    };
    const problems = manifestProblems(lib, '^1.0.0');
    assert.deepEqual(
        problems.map((p) => [p.kind, p.field, p.dep, p.spec]),
        [
            ['shape', 'peerDependencies', 'sigx', '^0.15.0'],
            ['shape', 'devDependencies', '@sigx/cache', '(missing)'],
        ],
    );
});

test('a publishable package in the right shape has no problems', () => {
    const lib = {
        name: '@acme/lib',
        dependencies: { '@sigx/serialize': 'catalog:' },
        peerDependencies: { sigx: '^1.0.0', '@sigx/server-renderer': '^1.0.0' },
        devDependencies: { sigx: 'catalog:', '@sigx/server-renderer': 'catalog:', '@sigx/vite': 'catalog:' },
    };
    assert.deepEqual(manifestProblems(lib, '^1.0.0'), []);
});

test('with no catalog pin to derive from, a peer is only checked for caret shape', () => {
    const lib = { name: '@acme/lib', peerDependencies: { sigx: '^1.0.0' }, devDependencies: { sigx: 'catalog:' } };
    assert.deepEqual(manifestProblems(lib, null), []);
    const star = { name: '@acme/lib', peerDependencies: { sigx: '*' }, devDependencies: { sigx: 'catalog:' } };
    assert.equal(manifestProblems(star, null).length, 1);
});

test('alignManifest moves "catalog:" singletons to peers + dev twin, keeps key order, drops an emptied dependencies', () => {
    const lib = {
        name: '@acme/lib',
        version: '1.2.3',
        dependencies: { '@sigx/reactivity': 'catalog:', '@sigx/runtime-core': 'catalog:' },
        devDependencies: { typescript: '^5' },
        scripts: { build: 'x' },
    };
    const { pkg, changes } = alignManifest(lib, '^1.0.0');
    assert.equal(changes.length, 2);
    assert.deepEqual(Object.keys(pkg), ['name', 'version', 'peerDependencies', 'devDependencies', 'scripts']);
    assert.deepEqual(pkg.peerDependencies, { '@sigx/reactivity': '^1.0.0', '@sigx/runtime-core': '^1.0.0' });
    assert.deepEqual(pkg.devDependencies, {
        typescript: '^5',
        '@sigx/reactivity': 'catalog:',
        '@sigx/runtime-core': 'catalog:',
    });
    // The input is not mutated.
    assert.deepEqual(Object.keys(lib.dependencies), ['@sigx/reactivity', '@sigx/runtime-core']);
    // And the result is in shape.
    assert.deepEqual(manifestProblems(pkg, '^1.0.0'), []);
});

test('alignManifest keeps a non-singleton dependency, leaves an inline version alone, and is idempotent', () => {
    const lib = {
        name: '@acme/lib',
        dependencies: { '@sigx/serialize': 'catalog:', sigx: 'catalog:', '@sigx/cache': '^0.14.0' },
    };
    const first = alignManifest(lib, '^0.15.0');
    assert.deepEqual(first.pkg.dependencies, { '@sigx/serialize': 'catalog:', '@sigx/cache': '^0.14.0' });
    assert.deepEqual(first.pkg.peerDependencies, { sigx: '^0.15.0' });
    assert.deepEqual(first.pkg.devDependencies, { sigx: 'catalog:' });
    // The inline pin is the caller's to refuse, not ours to guess at.
    assert.ok(manifestProblems(first.pkg, '^0.15.0').some((p) => p.kind === 'inline' && p.dep === '@sigx/cache'));
    const second = alignManifest(first.pkg, '^0.15.0');
    assert.deepEqual(second.changes, []);
    assert.equal(second.pkg, first.pkg);
});

test('alignManifest re-pins an existing peer on a major bump and adds a missing twin', () => {
    const lib = {
        name: '@acme/lib',
        peerDependencies: { sigx: '^1.0.0', vite: '>=8' },
        devDependencies: { vite: '^8' },
    };
    const { pkg, changes } = alignManifest(lib, '^2.0.0');
    assert.equal(changes.length, 2);
    assert.deepEqual(pkg.peerDependencies, { sigx: '^2.0.0', vite: '>=8' });
    assert.deepEqual(pkg.devDependencies, { vite: '^8', sigx: 'catalog:' });
    assert.deepEqual(Object.keys(pkg), ['name', 'peerDependencies', 'devDependencies']);
});

test('alignManifest leaves a private manifest and a manifest with no range untouched', () => {
    const app = { name: 'app', private: true, dependencies: { sigx: 'catalog:' } };
    assert.equal(alignManifest(app, '^1.0.0').pkg, app);
    const lib = { name: '@acme/lib', dependencies: { sigx: 'catalog:' } };
    assert.equal(alignManifest(lib, null).pkg, lib);
});
