import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCatalog, normalizeExpected, catalogPeerRange } from './check-catalog.mjs';

// The gap this covers: checks 1 and 2 are structural, so they pass on a catalog
// still pinned to the PREVIOUS core minor — exactly what a `sync:core` that
// failed or never ran leaves behind. Hit for real on the core v0.14.0 rollout,
// where `verify:catalog` reported OK on an untouched ^0.13.0 catalog (#43).

const ws = (version) => [
    'packages:',
    '  - packages/*',
    '',
    '# Single source of truth for the SignalX core version this repo builds against.',
    `# \`^${version}\` == ONE minor.`,
    'catalog:',
    `  "@sigx/reactivity": ^${version}`,
    `  "@sigx/runtime-core": ^${version}`,
    `  sigx: ^${version}`,
    '',
].join('\n');

test('normalizeExpected accepts X.Y, X.Y.Z and a leading caret', () => {
    assert.equal(normalizeExpected('0.14'), '^0.14.0');
    // Patch is ignored — the pin is a single MINOR, always `.0`.
    assert.equal(normalizeExpected('0.14.3'), '^0.14.0');
    assert.equal(normalizeExpected('^0.14.0'), '^0.14.0');
    assert.equal(normalizeExpected(' 1.0 '), '^1.0.0');
});

test('normalizeExpected accepts a prerelease of a NEW MAJOR, pinned exactly', () => {
    // `^1.0.0` does not resolve `1.0.0-rc.0`; the exact caret is the only pin
    // an rc alignment can use, and it keeps matching rc.1 and 1.0.0 itself.
    assert.equal(normalizeExpected('1.0.0-rc.0'), '^1.0.0-rc.0');
    assert.equal(normalizeExpected('^2.0.0-beta.1'), '^2.0.0-beta.1');
});

test('normalizeExpected rejects a non-version instead of degrading silently', () => {
    // Returning null matters: treating garbage as "no expectation" would report
    // OK on a stale catalog, which is the bug this whole check exists to close.
    // A prerelease of a later minor (0.14.0-rc.1) is not a pin either —
    // consumers align to releases; the rc case exists only for a new major.
    for (const bad of ['latest', 'v0.14', '0', '', 'main', '0.14.0-rc.1', '1.1.0-beta.0']) {
        assert.equal(normalizeExpected(bad), null, `${JSON.stringify(bad)} should not parse`);
    }
});

test('passes structurally with no expected version, whatever the minor', () => {
    assert.deepEqual(checkCatalog(ws('0.13.0')), []);
    assert.deepEqual(checkCatalog(ws('0.14.0')), []);
});

test('passes when the catalog matches the expected version', () => {
    assert.deepEqual(checkCatalog(ws('0.14.0'), '^0.14.0'), []);
});

test('the exact prerelease caret of a new major is a valid pin; a later-minor prerelease is not', () => {
    assert.deepEqual(checkCatalog(ws('1.0.0-rc.0')), []);
    assert.deepEqual(checkCatalog(ws('1.0.0-rc.0'), '^1.0.0-rc.0'), []);
    const errors = checkCatalog(ws('1.1.0-beta.0'));
    assert.equal(errors.length, 3);
    assert.match(errors[0], /must be single-minor/);
});

test('FAILS on a stale catalog the structural check calls fine', () => {
    const errors = checkCatalog(ws('0.13.0'), '^0.14.0');
    assert.equal(errors.length, 3, 'every core entry should be reported, not just the first');
    assert.match(errors[0], /@sigx\/reactivity/);
    assert.match(errors[0], /\^0\.13\.0/, 'names what was found');
    assert.match(errors[0], /expected \^0\.14\.0/, 'names what was wanted');
    assert.match(errors[0], /pnpm sync:core 0\.14/, 'names the remedy, with the minor only');
    // For an rc the remedy names the exact version, since the minor alone cannot reach it.
    const [pre] = checkCatalog(ws('0.15.0'), '^1.0.0-rc.0');
    assert.match(pre, /run `pnpm sync:core 1\.0\.0-rc\.0`/);
});

test('a wide range is still reported as wide, not as a version mismatch', () => {
    // Check 2 must win: ">=0.13.0 <0.15.0" re-opens the two-copies hazard, and
    // saying "expected ^0.14.0" would send the reader to `sync:core`, which is
    // not the fix — the entry has to become a caret first.
    const src = [
        'catalog:',
        '  "@sigx/reactivity": ">=0.13.0 <0.15.0"',
        '',
    ].join('\n');
    const errors = checkCatalog(src, '^0.14.0');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must be single-minor/);
    assert.doesNotMatch(errors[0], /expected/);
});

test('ignores sibling-ecosystem entries sharing the catalog', () => {
    // @sigx/router et al. are NOT core and follow their own release cadence;
    // holding them to the core minor would fail every repo that consumes one.
    const src = [
        'catalog:',
        '  "@sigx/reactivity": ^0.14.0',
        '  "@sigx/router": ^0.10.0',
        '  "@sigx/store": ^0.12.0',
        '',
    ].join('\n');
    assert.deepEqual(checkCatalog(src, '^0.14.0'), []);
});

test('a column-0 comment inside the block does not end it', () => {
    // Same rule as sync-core.mjs's walk. A comment is valid YAML anywhere in a
    // mapping; treating it as the terminator skipped every entry below it, so a
    // stale pin sitting under a comment would pass unseen.
    const src = [
        'catalog:',
        '  "@sigx/reactivity": ^0.14.0',
        '# a comment at column 0, mid-block',
        '  "@sigx/runtime-core": ^0.13.0',
        '',
    ].join('\n');
    const errors = checkCatalog(src, '^0.14.0');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /@sigx\/runtime-core/);
});

test('a real key at column 0 DOES end the block', () => {
    // Beyond the catalog, `sigx: ^0.13.0` is a different mapping entirely and
    // must not be policed as a pin.
    const src = [
        'catalog:',
        '  "@sigx/reactivity": ^0.14.0',
        'onlyBuiltDependencies:',
        '  sigx: ^0.13.0',
        '',
    ].join('\n');
    assert.deepEqual(checkCatalog(src, '^0.14.0'), []);
});

test('a repo with no catalog has nothing to police', () => {
    assert.deepEqual(checkCatalog('', '^0.14.0'), []);
    assert.deepEqual(checkCatalog('packages:\n  - packages/*\n', '^0.14.0'), []);
});

test('handles single-quoted and bare values, as terminal writes them', () => {
    const src = [
        'catalog:',
        "  '@sigx/reactivity': ^0.13.0",
        '  sigx: ^0.13.0',
        '',
    ].join('\n');
    const errors = checkCatalog(src, '^0.14.0');
    assert.equal(errors.length, 2, 'quoting style must not hide an entry');
});

test('catalogPeerRange derives the peer range a library must declare from the first core pin', () => {
    // 0.x: a caret is one minor, so the pin IS the range; 1.x+: wide; an rc of
    // X.0.0: exact. A catalog with no core entry (siblings only) derives nothing,
    // and the manifest check then judges peers by shape alone.
    assert.equal(catalogPeerRange(ws('0.15.0')), '^0.15.0');
    assert.equal(catalogPeerRange(ws('1.4.0')), '^1.0.0');
    assert.equal(catalogPeerRange(ws('1.0.0-rc.0')), '^1.0.0-rc.0');
    assert.equal(catalogPeerRange('catalog:\n  "@sigx/router": ^0.5.0\n'), null);
    assert.equal(catalogPeerRange(''), null);
});
