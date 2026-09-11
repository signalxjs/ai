import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignCatalog, alignManifests } from './sync-core.mjs';

// The comment formats below are copied verbatim from real consumer repos
// (i18n/pulse, terminal, router, store, use, monaco-editor) — the exact prose
// `sync:core` used to leave stale on every core bump, which is what turned clean
// catalog bumps AMBER when Copilot flagged them (#41).

test('bumps the catalog pins AND the explanatory comment (both token forms)', () => {
    // i18n / pulse / monaco format: cites both `^X.Y.0` and `>=X.Y.0 <X.(Y+1).0`.
    const src = [
        'packages:',
        '  - packages/*',
        '',
        '# Single source of truth for the SignalX core version this repo builds against.',
        '# `^0.12.0` == `>=0.12.0 <0.13.0` (ONE minor).',
        "# @sigx/reactivity keeps reactive state in module-local variables — bump this",
        '# one block to move the whole repo to a new core minor.',
        'catalog:',
        '  "@sigx/reactivity": ^0.12.0',
        '  "@sigx/runtime-core": ^0.12.0',
        '  sigx: ^0.12.0',
        '',
    ].join('\n');

    const { text, pins, comments } = alignCatalog(src, '^0.13.0');

    // Pins moved.
    assert.equal(pins.length, 3);
    assert.match(text, /"@sigx\/reactivity": \^0\.13\.0/);
    assert.match(text, /sigx: \^0\.13\.0/);

    // Comment moved — the whole point of this fix.
    assert.ok(comments.length >= 1, 'comment change should be reported');
    assert.match(text, /`\^0\.13\.0` == `>=0\.13\.0 <0\.14\.0` \(ONE minor\)\./);

    // And nothing in the comment still cites the old minor.
    const commentBlock = text.split('\n').filter((l) => l.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(commentBlock, /0\.12/, 'no stale 0.12 token may survive in the comment');
});

test('bumps a terminal-style single-caret comment', () => {
    const src = [
        'packages:',
        '  - packages/*',
        '',
        '# Single source of truth for the SignalX core version. Every package references',
        '# these as "catalog:", which pnpm rewrites to the range below on pack/publish.',
        '# Keep core single-minor (^0.12.0) — two @sigx/reactivity copies break reactivity.',
        'catalog:',
        "  '@sigx/reactivity': ^0.12.0",
        "  '@sigx/vite': ^0.12.0",
        '',
    ].join('\n');

    const { text } = alignCatalog(src, '^0.13.0');
    assert.match(text, /Keep core single-minor \(\^0\.13\.0\)/);
    // Single-quoted pins preserved as single-quoted.
    assert.match(text, /'@sigx\/reactivity': \^0\.13\.0/);
    assert.doesNotMatch(text, /0\.12/);
});

test('bumps a router-style backtick comment with an explicit range', () => {
    const src = [
        'packages:',
        '  - packages/*',
        '',
        '# Single source of truth for the SignalX core version the router builds against.',
        '# `^0.12.0` == `>=0.12.0 <0.13.0` (ONE minor). @sigx/reactivity keeps reactive',
        '# state in module-local variables, so two physical copies break reactivity.',
        'catalog:',
        '  "@sigx/reactivity": ^0.12.0',
        '  sigx: ^0.12.0',
    ].join('\n');

    const { text } = alignCatalog(src, '^0.13.0');
    assert.match(text, /`\^0\.13\.0` == `>=0\.13\.0 <0\.14\.0`/);
    assert.doesNotMatch(text.split('\n').filter((l) => l.trimStart().startsWith('#')).join('\n'), /0\.12/);
});

test('leaves sibling-ecosystem catalog entries untouched', () => {
    const src = [
        '# Keep core single-minor (^0.12.0).',
        'catalog:',
        '  "@sigx/reactivity": ^0.12.0',
        '  "@sigx/router": ^2.4.0',
        '  sigx: ^0.12.0',
    ].join('\n');

    const { text, pins } = alignCatalog(src, '^0.13.0');
    assert.match(text, /"@sigx\/router": \^2\.4\.0/, 'sibling pin must not move');
    assert.ok(pins.every((p) => p.name !== '@sigx/router'));
});

test('does not touch a version-shaped token outside the adjacent comment block', () => {
    // A comment that is NOT the run immediately above `catalog:` (there is a blank
    // line and the `packages:` mapping between them) must be left alone, even
    // though it contains caret/range tokens — e.g. a Node engines note.
    const src = [
        '# node engines: ^20.19.0 || >=22.12.0 <23.0.0 — unrelated to the core pin',
        '',
        'packages:',
        '  - packages/*',
        '',
        '# Keep core single-minor (^0.12.0).',
        'catalog:',
        '  "@sigx/reactivity": ^0.12.0',
    ].join('\n');

    const { text } = alignCatalog(src, '^0.13.0');
    assert.match(text, /# node engines: \^20\.19\.0 \|\| >=22\.12\.0 <23\.0\.0/, 'far-away comment untouched');
    assert.match(text, /Keep core single-minor \(\^0\.13\.0\)/, 'adjacent comment updated');
});

test('does not touch an unrelated-major caret INSIDE the adjacent comment block', () => {
    // The rewrite is keyed on the version the catalog currently pins (^0.12.0), so
    // an unrelated caret sharing the very same comment run — a Node engines note,
    // a different major — must survive untouched. (Copilot review on #42.)
    const src = [
        '# Requires Node ^20.19.0 || >=22.12.0. Core is single-minor (^0.12.0 == >=0.12.0 <0.13.0).',
        'catalog:',
        '  "@sigx/reactivity": ^0.12.0',
    ].join('\n');

    const { text } = alignCatalog(src, '^0.13.0');
    assert.match(text, /Requires Node \^20\.19\.0 \|\| >=22\.12\.0/, 'Node engines tokens untouched');
    assert.match(text, /single-minor \(\^0\.13\.0 == >=0\.13\.0 <0\.14\.0\)/, 'core tokens bumped');
});

test('a MAJOR bump moves the old ^0.x correctly (keyed on the current pin, not the target)', () => {
    const src = [
        '# `^0.12.0` == `>=0.12.0 <0.13.0` (ONE minor).',
        'catalog:',
        '  "@sigx/reactivity": ^0.12.0',
        '  sigx: ^0.12.0',
    ].join('\n');

    const { text } = alignCatalog(src, '^1.0.0');
    // From 1.0 a caret spans the MAJOR: ^1.0.0 == >=1.0.0 <2.0.0, not <1.1.0.
    assert.match(text, /`\^1\.0\.0` == `>=1\.0\.0 <2\.0\.0`/, 'comment moved to the new major');
    // …and the next bump on the 1.x line still finds and rewrites that range.
    const next = alignCatalog(text, '^1.1.0');
    assert.match(next.text, /`\^1\.1\.0` == `>=1\.1\.0 <2\.0\.0`/, 'a 1.x comment is rewritten on the next minor');
    assert.match(text, /"@sigx\/reactivity": \^1\.0\.0/);
});

test('is idempotent — a second run makes no further change', () => {
    const src = [
        '# `^0.12.0` == `>=0.12.0 <0.13.0` (ONE minor).',
        'catalog:',
        '  "@sigx/reactivity": ^0.12.0',
        '  sigx: ^0.12.0',
    ].join('\n');

    const first = alignCatalog(src, '^0.13.0');
    const second = alignCatalog(first.text, '^0.13.0');
    assert.equal(second.pins.length, 0);
    assert.equal(second.comments.length, 0);
    assert.equal(second.text, first.text);
});

test('leaves the comment alone when the catalog is already on the target (precise scoping)', () => {
    // The rewrite is keyed on the version the catalog CURRENTLY pins. When the pins
    // are already the target there is no current-but-stale core minor to key on, so
    // the comment is left untouched rather than guessing which token is "the core
    // one" — the deliberate trade for never clobbering an unrelated version. In the
    // real workflow the pin bump and comment always move together.
    const src = [
        '# Keep core single-minor (^0.12.0).',
        'catalog:',
        '  "@sigx/reactivity": ^0.13.0',
        '  sigx: ^0.13.0',
    ].join('\n');

    const { text, pins, comments } = alignCatalog(src, '^0.13.0');
    assert.equal(pins.length, 0, 'no pin change');
    assert.equal(comments.length, 0, 'no comment change');
    assert.equal(text, src, 'file untouched');
});

test('handles the minor rollover in the explicit range (0.13 -> <0.14.0)', () => {
    const src = ['# `^0.13.0` == `>=0.13.0 <0.14.0`.', 'catalog:', '  sigx: ^0.13.0'].join('\n');
    const { text } = alignCatalog(src, '^0.14.0');
    assert.match(text, /`\^0\.14\.0` == `>=0\.14\.0 <0\.15\.0`/);
});

test('rejects a range that is not a single-minor caret', () => {
    assert.throws(() => alignCatalog('catalog:\n  sigx: ^0.13.0', '>=0.13.0 <0.14.0'), /single-minor caret/);
});

test('a prerelease of a new major pins exactly — the only caret that resolves an rc', () => {
    const src = [
        '# `^0.15.0` == `>=0.15.0 <0.16.0` (ONE minor).',
        'catalog:',
        '  sigx: ^0.15.0',
        '  "@sigx/router": ^0.5.0',
        '',
    ].join('\n');
    const { text, pins } = alignCatalog(src, '^1.0.0-rc.0');
    assert.deepEqual(pins, [{ name: 'sigx', from: '^0.15.0', to: '^1.0.0-rc.0' }]);
    assert.match(text, /sigx: \^1\.0\.0-rc\.0/);
    assert.match(text, /"@sigx\/router": \^0\.5\.0/, 'siblings untouched');
    assert.match(text, /`\^1\.0\.0-rc\.0` == `>=1\.0\.0-rc\.0 <2\.0\.0`/, 'the comment names the exact pin, major-wide');
    // The rc pin is itself rewritten once 1.0.0 ships.
    const stable = alignCatalog(text, '^1.0.0');
    assert.match(stable.text, /sigx: \^1\.0\.0$/m);
    assert.match(stable.text, /`\^1\.0\.0` == `>=1\.0\.0 <2\.0\.0`/);
    // A prerelease of a later minor is not a pin.
    assert.throws(() => alignCatalog(src, '^1.1.0-beta.0'), /single-minor caret/);
});

test("alignManifests writes the peer shape into publishable packages only, keeping each file's indent", () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-core-'));
    try {
        mkdirSync(join(root, 'packages', 'lib'), { recursive: true });
        mkdirSync(join(root, 'packages', 'app'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, devDependencies: { '@sigx/vite': 'catalog:' } }, null, 2) + '\n');
        writeFileSync(
            join(root, 'packages', 'lib', 'package.json'),
            JSON.stringify({ name: '@acme/lib', version: '1.0.0', dependencies: { sigx: 'catalog:', '@sigx/serialize': 'catalog:' }, devDependencies: { '@sigx/vite': 'catalog:' } }, null, 4) + '\n',
        );
        writeFileSync(
            join(root, 'packages', 'app', 'package.json'),
            JSON.stringify({ name: 'app', private: true, dependencies: { sigx: 'catalog:' } }, null, 2) + '\n',
        );

        const dry = alignManifests(root, '^1.0.0', { dryRun: true });
        assert.equal(dry.length, 1);
        assert.match(dry[0], /@acme\/lib: sigx dependencies "catalog:" -> peerDependencies "\^1\.0\.0"/);
        // A dry run wrote nothing.
        assert.match(readFileSync(join(root, 'packages', 'lib', 'package.json'), 'utf8'), /"dependencies": \{\n\s+"sigx": "catalog:"/);

        const wet = alignManifests(root, '^1.0.0');
        assert.deepEqual(wet, dry);
        const lib = readFileSync(join(root, 'packages', 'lib', 'package.json'), 'utf8');
        assert.match(lib, /^    "peerDependencies": \{$/m, 'four-space indent preserved');
        const parsed = JSON.parse(lib);
        assert.deepEqual(parsed.dependencies, { '@sigx/serialize': 'catalog:' });
        assert.deepEqual(parsed.peerDependencies, { sigx: '^1.0.0' });
        assert.deepEqual(parsed.devDependencies, { '@sigx/vite': 'catalog:', sigx: 'catalog:' });
        assert.deepEqual(Object.keys(parsed), ['name', 'version', 'dependencies', 'peerDependencies', 'devDependencies']);

        // Private manifests are left exactly as they were.
        assert.deepEqual(JSON.parse(readFileSync(join(root, 'packages', 'app', 'package.json'), 'utf8')).dependencies, { sigx: 'catalog:' });
        assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies, { '@sigx/vite': 'catalog:' });

        // Idempotent.
        assert.deepEqual(alignManifests(root, '^1.0.0', { dryRun: true }), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
