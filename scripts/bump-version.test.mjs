import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpVersion, applyBump } from './bump-version.js';

// Acceptance criterion from #39: bumping `@sigx/ai` 0.1.x → 0.2.0 rewrites every
// dependent in-repo range to `^0.2.0` in ONE command, leaving `workspace:*` and
// `catalog:` (rewritten by `pnpm pack`) alone.

function scratchRepo() {
    const root = mkdtempSync(join(tmpdir(), 'sigx-ai-bump-'));
    const write = (dir, pkg) => {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg, null, 4) + '\n');
    };
    write('ai', { name: '@sigx/ai', version: '0.1.3', peerDependencies: { '@sigx/runtime-core': '^0.15.0' } });
    write('ai-anthropic', {
        name: '@sigx/ai-anthropic',
        version: '0.1.3',
        devDependencies: { '@sigx/ai': 'workspace:*', '@sigx/vite': 'catalog:' },
        peerDependencies: { '@anthropic-ai/sdk': '>=0.100.0', '@sigx/ai': '^0.1.0' },
    });
    write('ai-agent-acp', {
        name: '@sigx/ai-agent-acp',
        version: '0.1.3',
        dependencies: { '@sigx/ai-agent-node': '^0.1.0' },
        peerDependencies: { '@sigx/ai': '^0.1.0' },
    });
    write('ai-agent-node', { name: '@sigx/ai-agent-node', version: '0.1.3' });
    write('demo', { name: 'demo', private: true, version: '0.0.0', dependencies: { '@sigx/ai': 'workspace:*' } });
    // Not a package: a stray directory without a manifest is skipped, as before.
    mkdirSync(join(root, 'notes'));
    return root;
}

const read = (root, dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf-8'));

test('bumpVersion handles the three bump kinds', () => {
    assert.equal(bumpVersion('0.1.3', 'patch'), '0.1.4');
    assert.equal(bumpVersion('0.1.3', 'minor'), '0.2.0');
    assert.equal(bumpVersion('0.1.3', 'major'), '1.0.0');
});

test('a minor bump rewrites dependent peer AND runtime in-repo ranges', () => {
    const root = scratchRepo();
    try {
        const log = [];
        const changes = applyBump(root, 'minor', { log: (l) => log.push(l) });
        assert.deepEqual(
            changes.map((c) => [c.name, c.from, c.to]),
            [
                ['@sigx/ai', '0.1.3', '0.2.0'],
                ['@sigx/ai-agent-acp', '0.1.3', '0.2.0'],
                ['@sigx/ai-agent-node', '0.1.3', '0.2.0'],
                ['@sigx/ai-anthropic', '0.1.3', '0.2.0'],
            ]
        );
        assert.equal(read(root, 'ai-anthropic').peerDependencies['@sigx/ai'], '^0.2.0');
        assert.equal(read(root, 'ai-agent-acp').peerDependencies['@sigx/ai'], '^0.2.0');
        assert.equal(read(root, 'ai-agent-acp').dependencies['@sigx/ai-agent-node'], '^0.2.0');
        // Untouched: third-party ranges, pack-time specifiers, core peers, private packages.
        assert.equal(read(root, 'ai-anthropic').peerDependencies['@anthropic-ai/sdk'], '>=0.100.0');
        assert.equal(read(root, 'ai-anthropic').devDependencies['@sigx/ai'], 'workspace:*');
        assert.equal(read(root, 'ai-anthropic').devDependencies['@sigx/vite'], 'catalog:');
        assert.equal(read(root, 'ai').peerDependencies['@sigx/runtime-core'], '^0.15.0');
        assert.equal(read(root, 'demo').version, '0.0.0');
        assert.equal(read(root, 'demo').dependencies['@sigx/ai'], 'workspace:*');
        // Manifest formatting is preserved: 4-space indent, trailing newline.
        const raw = readFileSync(join(root, 'ai-anthropic', 'package.json'), 'utf-8');
        assert.ok(raw.startsWith('{\n    "name"'));
        assert.ok(raw.endsWith('}\n'));
        assert.ok(log.some((l) => l.includes('@sigx/ai-anthropic peerDependencies.@sigx/ai: ^0.1.0 → ^0.2.0')));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an exact version sets every package and rewrites ranges to its caret', () => {
    const root = scratchRepo();
    try {
        applyBump(root, '1.0.0', { log: () => {} });
        assert.equal(read(root, 'ai').version, '1.0.0');
        assert.equal(read(root, 'ai-anthropic').peerDependencies['@sigx/ai'], '^1.0.0');
        assert.equal(read(root, 'ai-agent-acp').dependencies['@sigx/ai-agent-node'], '^1.0.0');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
