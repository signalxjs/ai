/**
 * core-deps.mjs — the shared half of the catalog-sync tooling.
 *
 * `sync-core.mjs` and `check-catalog.mjs` both need to know which packages are
 * "core", how a manifest is supposed to declare them, and how to find the ones
 * that do not. They used to carry their own copy of each, and the copies
 * drifted: core shipped `@sigx/serialize`, `@sigx/cloudflare`, `@sigx/vercel`
 * and `@sigx/netlify` while both lists still named ten packages, so a repo
 * pinning any of them got neither the rewrite nor the guard. One copy, here.
 *
 * THE SHAPE (core 1.0, rfc-1.0 §3.3 — signalxjs/core#633 phase 2, #53 here):
 *
 *   - A PRIVATE manifest (the repo root, an app, an example) declares every
 *     core package it uses as `"catalog:"`, in whichever field it uses — the
 *     catalog's single-minor pin is the one source of truth, as before.
 *   - A PUBLISHABLE package (a library) never carries its own copy of a core
 *     SINGLETON. It declares each one it needs in `peerDependencies` at the
 *     peer range (`^X.0.0` once core is on 1.x — wide, because 1.0 promises
 *     additive minors; the catalog's own `^0.Y.0` while core is on 0.x; the
 *     exact prerelease caret while aligned to an rc) AND in `devDependencies`
 *     as `"catalog:"`, which is what the repo itself builds and tests against.
 *     The app that installs the library owns the single copy; a lagging library
 *     surfaces as a named unmet-peer notice, never as a second copy at runtime.
 *   - The non-singleton core packages — the zero-dependency leaf
 *     `@sigx/serialize` (duplicates are harmless) and the build-time-only
 *     `@sigx/vite` + deployment adapters — are exempt from the peer rule and
 *     stay `"catalog:"` wherever the package uses them.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The packages published from signalxjs/core. Only these are rewritten by
 * `sync:core` and policed by `verify:catalog`.
 *
 * KEEP IN SYNC with `corePackages` in core's `docs/ecosystem.json` — core's CI
 * (`pnpm verify:ecosystem`) fails when a newly published package is missing
 * there, and that entry is the signal to update this list too. Also mirrored by
 * `SIGX_CORE_PACKAGES` in `@sigx/vite`.
 */
export const CORE_PACKAGES = new Set([
    'sigx',
    '@sigx/serialize',
    '@sigx/reactivity',
    '@sigx/runtime-core',
    '@sigx/runtime-dom',
    '@sigx/server-renderer',
    '@sigx/ssr-islands',
    '@sigx/resume',
    '@sigx/cache',
    '@sigx/server',
    '@sigx/vite',
    '@sigx/cloudflare',
    '@sigx/vercel',
    '@sigx/netlify',
]);

/**
 * Core packages a library does NOT peer on: not singletons, so a second copy
 * costs nothing (`@sigx/serialize`) or never reaches a runtime at all (the Vite
 * plugin and the deployment adapters are build-time Node code). They stay
 * `"catalog:"` in whichever field the package uses.
 */
export const PEER_EXEMPT = new Set([
    '@sigx/serialize',
    '@sigx/vite',
    '@sigx/cloudflare',
    '@sigx/vercel',
    '@sigx/netlify',
]);

/** The core packages that carry per-process state — the ones a library peers on. */
export const SINGLETON_PACKAGES = new Set([...CORE_PACKAGES].filter((name) => !PEER_EXEMPT.has(name)));

/** The dependency sections a core dep can hide in. */
export const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const CARET = /^\^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/**
 * The peer range a library declares, derived from the catalog's pin:
 *
 *   ^0.15.0      -> ^0.15.0      (0.x: a caret is one minor, so the pin IS the range)
 *   ^1.3.0       -> ^1.0.0       (1.x+: wide — every 1.x resolves the app's copy)
 *   ^1.0.0-rc.0  -> ^1.0.0-rc.0  (an rc of X.0.0: the only caret that resolves it,
 *                                 and it keeps matching once X.0.0 ships)
 *
 * `null` for anything that is not a caret (the caller reports the catalog
 * itself as malformed).
 */
export function peerRangeFor(catalogPin) {
    const m = CARET.exec(String(catalogPin ?? '').trim());
    if (!m) return null;
    const [, major, minor, patch, pre] = m;
    if (Number(major) === 0) return `^${major}.${minor}.${patch}${pre ?? ''}`;
    if (pre && Number(minor) === 0 && Number(patch) === 0) return `^${major}.0.0${pre}`;
    return `^${major}.0.0`;
}

/** A manifest that publishes — the shape rules split on this. */
export function isPublishable(pkg) {
    return typeof pkg?.name === 'string' && pkg.private !== true;
}

/**
 * Where workspace packages live, across the repo shapes in this org.
 *
 * Each is checked BOTH as a container of packages (`packages/<name>/package.json`,
 * the usual shape) and as a package itself (`app/package.json`) — `signalxjs/pulse`
 * declares `- app` as a workspace entry, and scanning only one level down made its
 * inline core pins invisible to `verify:catalog`. A guard that silently sees nothing
 * is the failure this whole file exists to prevent.
 */
const WORKSPACE_DIRS = ['packages', 'app', 'apps', 'examples'];

/** Every package.json to inspect under `repoRoot`. */
export function workspaceManifests(repoRoot) {
    const files = [];
    // The ROOT manifest first. A single-package repo has no workspace dirs at all
    // (adopting.md explicitly supports that shape), and a monorepo root can still
    // declare a core dep directly — either way, skipping it would let inline pins
    // through the guard entirely. `"catalog:"` resolves in the root manifest too.
    const rootManifest = join(repoRoot, 'package.json');
    if (existsSync(rootManifest)) files.push(rootManifest);
    for (const base of WORKSPACE_DIRS) {
        const dir = join(repoRoot, base);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
        // The directory may itself be a package.
        const own = join(dir, 'package.json');
        if (existsSync(own)) files.push(own);
        // ...and/or a container of them.
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (!statSync(path).isDirectory()) continue;
            const manifest = join(path, 'package.json');
            if (existsSync(manifest)) files.push(manifest);
        }
    }
    return files;
}

/**
 * Every way ONE manifest departs from the shape above.
 *
 * Two kinds, because the two tools treat them differently:
 *   - `inline`: a core dep with a literal version where `"catalog:"` is required.
 *     `verify:catalog` fails on it; `sync:core` REFUSES to run on it, because it
 *     can align a catalog and move a `"catalog:"` dep between fields but it will
 *     not guess which catalog entry a hand-written `^0.12.0` meant.
 *   - `shape`: a publishable package carrying a singleton in `dependencies`, a
 *     peer at the wrong range, or a peer without its `devDependencies` twin.
 *     `verify:catalog` fails on it; `sync:core` fixes it (`alignManifest`).
 *
 * @param {object} pkg            the parsed package.json
 * @param {string|null} peerRange the range a peer must carry (from `peerRangeFor`),
 *                                or null when the catalog has no core pin to derive
 *                                it from — the range is then only checked for shape
 * @returns {{ kind: 'inline'|'shape', field: string, dep: string, spec: string, must: string }[]}
 */
export function manifestProblems(pkg, peerRange = null) {
    const problems = [];
    const publishable = isPublishable(pkg);
    for (const field of DEP_FIELDS) {
        for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
            if (!CORE_PACKAGES.has(dep)) continue;
            const singleton = publishable && SINGLETON_PACKAGES.has(dep);
            if (field === 'dependencies' && singleton) {
                problems.push({
                    kind: spec === 'catalog:' ? 'shape' : 'inline',
                    field, dep, spec,
                    must: `move to peerDependencies "${peerRange ?? '^X.0.0'}" + devDependencies "catalog:" — a library never carries its own copy of a core singleton`,
                });
                continue;
            }
            if (field === 'peerDependencies' && singleton) {
                if (peerRange ? spec !== peerRange : !CARET.test(spec)) {
                    problems.push({
                        kind: 'shape', field, dep, spec,
                        must: `"${peerRange ?? '^X.0.0'}" (the peer range derived from the catalog pin)`,
                    });
                }
                if (pkg.devDependencies?.[dep] !== 'catalog:') {
                    problems.push({
                        kind: 'shape', field: 'devDependencies', dep, spec: pkg.devDependencies?.[dep] ?? '(missing)',
                        must: '"catalog:" — the twin the repo builds and tests against; the peer only resolves the app\'s copy',
                    });
                }
                continue;
            }
            if (spec !== 'catalog:') {
                problems.push({ kind: 'inline', field, dep, spec, must: '"catalog:"' });
            }
        }
    }
    return problems;
}

/**
 * Rewrite ONE publishable manifest to the shape: every core singleton in
 * `dependencies` (as `"catalog:"`) moves to `peerDependencies` at `peerRange`
 * with a `devDependencies: "catalog:"` twin; an existing singleton peer is
 * re-pinned to `peerRange` (a major bump moves `^1.0.0` to `^2.0.0`) and gets
 * its twin if it lacks one. Inline versions are left for the caller to refuse;
 * a private manifest is returned untouched. Pure: returns a new object with the
 * original key order, `peerDependencies` placed after `dependencies` (or before
 * `devDependencies`) when it is new.
 *
 * @returns {{ pkg: object, changes: string[] }}
 */
export function alignManifest(pkg, peerRange) {
    const changes = [];
    if (!isPublishable(pkg) || !peerRange) return { pkg, changes };

    const deps = { ...(pkg.dependencies ?? {}) };
    const peers = { ...(pkg.peerDependencies ?? {}) };
    const dev = { ...(pkg.devDependencies ?? {}) };

    for (const [dep, spec] of Object.entries(deps)) {
        if (!SINGLETON_PACKAGES.has(dep) || spec !== 'catalog:') continue;
        delete deps[dep];
        peers[dep] = peerRange;
        if (dev[dep] !== 'catalog:') dev[dep] = 'catalog:';
        changes.push(`${pkg.name}: ${dep} dependencies "catalog:" -> peerDependencies "${peerRange}" + devDependencies "catalog:"`);
    }
    for (const [dep, spec] of Object.entries(peers)) {
        if (!SINGLETON_PACKAGES.has(dep)) continue;
        if (spec !== peerRange) {
            peers[dep] = peerRange;
            changes.push(`${pkg.name}: ${dep} peerDependencies "${spec}" -> "${peerRange}"`);
        }
        if (dev[dep] !== 'catalog:') {
            dev[dep] = 'catalog:';
            changes.push(`${pkg.name}: ${dep} devDependencies "catalog:" added (the peer's twin)`);
        }
    }
    if (changes.length === 0) return { pkg, changes };

    const hadPeers = 'peerDependencies' in pkg;
    const out = {};
    for (const [key, value] of Object.entries(pkg)) {
        if (key === 'dependencies') {
            if (Object.keys(deps).length) out.dependencies = deps;
            if (!hadPeers) out.peerDependencies = peers;
            continue;
        }
        if (key === 'peerDependencies') { out.peerDependencies = peers; continue; }
        if (key === 'devDependencies') {
            if (!hadPeers && !('peerDependencies' in out)) out.peerDependencies = peers;
            out.devDependencies = dev;
            continue;
        }
        out[key] = value;
    }
    if (!('peerDependencies' in out)) out.peerDependencies = peers;
    if (!('devDependencies' in out)) out.devDependencies = dev;
    return { pkg: out, changes };
}

/**
 * Every departure from the shape across the repo — `manifestProblems` over
 * `workspaceManifests`, each hit naming its file and package.
 *
 * @param {string} repoRoot
 * @param {string|null} peerRange
 * @returns {{ kind: string, file: string, pkg: string, field: string, dep: string, spec: string, must: string }[]}
 */
export function findInlineCoreDeps(repoRoot, peerRange = null) {
    const found = [];
    for (const manifest of workspaceManifests(repoRoot)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        for (const problem of manifestProblems(pkg, peerRange)) {
            found.push({ file: manifest, pkg: pkg.name ?? manifest, ...problem });
        }
    }
    return found;
}

/**
 * Render `findInlineCoreDeps` output — every departure from the shape, the
 * `inline` and the `shape` kind alike — as bare report lines, each naming what
 * the specifier must be; callers add their own bullet.
 */
export function formatInlineCoreDeps(hits) {
    return hits.map((h) => `${h.pkg} ${h.field}["${h.dep}"] = "${h.spec}" (must be ${h.must})`);
}
