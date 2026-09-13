/**
 * Bump every publishable package under `packages/` in lockstep, then rewrite
 * the in-repo ranges dependents declare on them (`peerDependencies` and
 * `dependencies` such as `"@sigx/ai": "^0.1.0"`) to the new caret, so the
 * family always installs together. `workspace:*` / `catalog:` specifiers are
 * left to `pnpm pack`. Private packages are skipped entirely.
 *
 * Usage:
 *   node scripts/bump-version.js [patch|minor|major|X.Y.Z]   (default: patch)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { caretRange, isPackTimeSpecifier } from './lib/ranges.mjs';

const BUMP_KINDS = new Set(['patch', 'minor', 'major']);
/** An exact release version, whole-string — `0.2.0.1` or `0.2.0rc` is a typo, not a version. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export function bumpVersion(version, type) {
    const parts = version.split('.').map(Number);
    switch (type) {
        case 'major':
            return `${parts[0] + 1}.0.0`;
        case 'minor':
            return `${parts[0]}.${parts[1] + 1}.0`;
        case 'patch':
            return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
        default:
            // Release tooling must not guess: a typo would silently ship a patch bump.
            throw new Error(`unknown bump kind "${type}" — use patch, minor, major or an exact X.Y.Z`);
    }
}

const RANGE_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/** Every `<dir>/package.json` under `packagesDir`, parsed, sorted by name for stable output. */
function readManifests(packagesDir) {
    const manifests = [];
    for (const entry of readdirSync(packagesDir)) {
        const dir = join(packagesDir, entry);
        if (!statSync(dir).isDirectory()) continue;
        const path = join(dir, 'package.json');
        let pkg;
        try {
            pkg = JSON.parse(readFileSync(path, 'utf-8'));
        } catch {
            continue; // no manifest — not a package
        }
        manifests.push({ path, pkg });
    }
    return manifests.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

/**
 * Apply a bump (`patch` | `minor` | `major`) or an exact version to every
 * publishable package in `packagesDir`, rewriting dependents' in-repo ranges.
 * Returns `[{ name, from, to }]` for the bumped packages. `log` receives one
 * line per change.
 */
export function applyBump(packagesDir, arg = 'patch', { log = console.log } = {}) {
    const exactVersion = EXACT_VERSION.test(arg) ? arg : null;
    const bumpType = exactVersion ? null : arg;
    if (!exactVersion && !BUMP_KINDS.has(bumpType)) {
        throw new Error(`unknown bump kind "${arg}" — use patch, minor, major or an exact X.Y.Z`);
    }

    const manifests = readManifests(packagesDir);
    const changes = [];
    const newVersions = new Map();
    for (const { pkg } of manifests) {
        if (pkg.private) {
            log(`Skipping private package: ${pkg.name}`);
            continue;
        }
        const to = exactVersion ?? bumpVersion(pkg.version, bumpType);
        changes.push({ name: pkg.name, from: pkg.version, to });
        newVersions.set(pkg.name, to);
    }

    for (const { path, pkg } of manifests) {
        let dirty = false;
        const to = newVersions.get(pkg.name);
        if (to !== undefined) {
            pkg.version = to;
            dirty = true;
        }
        // A private package keeps `workspace:*` on its siblings, so this loop
        // is a no-op for it — but a literal range there would follow the bump too.
        for (const field of RANGE_FIELDS) {
            for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
                const version = newVersions.get(dep);
                if (version === undefined || isPackTimeSpecifier(spec)) continue;
                const range = caretRange(version);
                if (spec === range) continue;
                pkg[field][dep] = range;
                log(`${pkg.name} ${field}.${dep}: ${spec} → ${range}`);
                dirty = true;
            }
        }
        if (dirty) writeFileSync(path, JSON.stringify(pkg, null, 4) + '\n');
    }

    for (const c of changes) log(`${c.name}: ${c.from} → ${c.to}`);
    return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const arg = process.argv[2] || 'patch';
    const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');
    console.log(EXACT_VERSION.test(arg) ? `Setting all packages to version ${arg}...\n` : `Bumping ${arg} version for packages...\n`);
    applyBump(packagesDir, arg);
    console.log('\nDone!');
}
