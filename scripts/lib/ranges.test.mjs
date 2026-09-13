import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretRange, satisfiesCaret, assertInRepoRanges } from './ranges.mjs';

// The gap this covers: `bump-version` moved every package's `version` but left
// dependents' `peerDependencies` on the previous caret, so a minor bump would
// publish packages that cannot install together (#39).

test('caretRange keeps the minor for 0.x and only the major from 1.0', () => {
    assert.equal(caretRange('0.2.0'), '^0.2.0');
    assert.equal(caretRange('0.2.7'), '^0.2.0');
    assert.equal(caretRange('1.4.2'), '^1.0.0');
    // 0.0.x carets are patch-pinned in semver: the only range that matches is the exact one.
    assert.equal(caretRange('0.0.3'), '^0.0.3');
});

test('satisfiesCaret follows caret semantics on both sides of 1.0', () => {
    assert.equal(satisfiesCaret('^0.1.0', '0.1.5'), true);
    assert.equal(satisfiesCaret('^0.1.0', '0.2.0'), false);
    assert.equal(satisfiesCaret('^1.0.0', '1.9.3'), true);
    assert.equal(satisfiesCaret('^1.0.0', '2.0.0'), false);
    assert.equal(satisfiesCaret('^1.2.0', '1.1.9'), false);
    assert.equal(satisfiesCaret('^0.0.3', '0.0.3'), true);
    assert.equal(satisfiesCaret('^0.0.3', '0.0.4'), false);
    assert.equal(satisfiesCaret('^0.0.0', '0.0.9'), false);
    assert.equal(satisfiesCaret('^0.1.0', '0.1.0-rc.1'), false);
    // Anything that is not a plain caret is never "satisfied" — in-repo ranges are carets by convention.
    assert.equal(satisfiesCaret('>=0.1.0', '0.1.0'), false);
    assert.equal(satisfiesCaret('workspace:*', '0.1.0'), false);
});

test('assertInRepoRanges throws on a stale in-repo range and names it', () => {
    const manifests = [
        { name: '@sigx/ai', version: '0.2.0' },
        { name: '@sigx/ai-anthropic', version: '0.2.0', peerDependencies: { '@sigx/ai': '^0.1.0', '@anthropic-ai/sdk': '>=0.100.0' } },
    ];
    assert.throws(() => assertInRepoRanges(manifests), /@sigx\/ai-anthropic peerDependencies\.@sigx\/ai = \^0\.1\.0 does not satisfy 0\.2\.0/);
});

test('assertInRepoRanges accepts caret ranges that match, and pack-time specifiers', () => {
    const manifests = [
        { name: '@sigx/ai', version: '0.2.0' },
        { name: '@sigx/ai-agent', version: '0.2.0', peerDependencies: { '@sigx/ai': '^0.2.0' }, devDependencies: { '@sigx/ai': 'workspace:*' } },
        { name: '@sigx/ai-agent-acp', version: '0.2.0', dependencies: { '@sigx/ai-agent-node': 'workspace:*' } },
        { name: '@sigx/ai-agent-node', version: '0.2.0' },
    ];
    // Third-party ranges are not in-repo and are left alone.
    assert.doesNotThrow(() => assertInRepoRanges(manifests));
});
