#!/usr/bin/env node
/**
 * check-catalog.mjs — CI guard (`pnpm verify:catalog`). Fails if:
 *   1. any manifest departs from the core dependency SHAPE (`lib/core-deps.mjs`):
 *      a private manifest declares a core dep with an inline version instead of
 *      `"catalog:"` (drift — the whole point is one source of truth); a
 *      publishable package carries a core singleton in `dependencies`, peers on
 *      one at a range other than the one the catalog pin derives, or peers
 *      without the `devDependencies: "catalog:"` twin (core 1.0's "the app owns
 *      the copy", rfc-1.0 §3.3 — #53),
 *   2. a `catalog:` core entry is NOT a single-minor caret `^X.Y.0` — or, while
 *      aligned to a prerelease of a new major, the exact caret `^X.0.0-<pre>`
 *      (`^1.0.0-rc.0`; any prerelease suffix, the rule is the position not the
 *      spelling — a wider range like `>=0.11 <0.13` re-opens the two-copies
 *      hazard), or
 *   3. an expected version was given and a core entry does not match it.
 *
 * Checks 1 and 2 are STRUCTURAL — they say the catalog is *a* single minor, not
 * *which* one. That is a real gap: they pass on a catalog still pinned to the
 * previous core minor, which is exactly what a `sync:core` that failed or never
 * ran leaves behind. The per-repo rollout procedure runs `sync:core` then
 * `verify:catalog` to catch that, and without check 3 it cannot (#43).
 *
 *   node scripts/check-catalog.mjs              # structural only
 *   node scripts/check-catalog.mjs 0.14         # every core entry must be ^0.14.0
 *   node scripts/check-catalog.mjs 0.14.0       # patch ignored, as in sync-core.mjs
 *   node scripts/check-catalog.mjs 1.0.0-rc.0   # every core entry must be ^1.0.0-rc.0
 *
 * Wire into ci.yml. Generalises lynx's check-versions.js to the catalog model.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CORE_PACKAGES, findInlineCoreDeps, formatInlineCoreDeps, peerRangeFor } from './lib/core-deps.mjs';

// ^X.Y.0 — one minor; or ^X.0.0-<pre> — the exact caret an rc of a new major
// needs (nothing else resolves a prerelease), which keeps matching once X.0.0
// ships. A prerelease of a later minor (^1.1.0-beta.0) is deliberately NOT a
// pin: consumers align to releases, and the rc case exists only because a
// major's first release has no stable version to pin.
const SINGLE_MINOR = /^\^\d+\.\d+\.0$|^\^\d+\.0\.0-[0-9A-Za-z.-]+$/;

// Value may be quoted (and a quoted value may contain spaces, e.g. a wide range
// like ">=0.11.0 <0.13.0") or bare. Capture all three forms so wide ranges are
// caught, not silently skipped.
const entryRe = /^\s+(["']?)([@a-zA-Z0-9._/-]+)\1\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/;

/**
 * Normalise a user-supplied version to the caret form the catalog pins.
 * Accepts `0.14`, `0.14.0` and `^0.14.0` (the patch is ignored because the pin
 * is always `.0` — a single minor, not a single patch) and a prerelease of a
 * new major, `1.0.0-rc.0`, which pins exactly. Returns null when the argument
 * is not a version at all, so the caller can reject it loudly rather than
 * silently degrading to a structural-only run that reports OK.
 */
export function normalizeExpected(arg) {
    const s = String(arg).trim();
    const pre = /^\^?(\d+)\.0\.0(-[0-9A-Za-z.-]+)$/.exec(s);
    if (pre) return `^${pre[1]}.0.0${pre[2]}`;
    const m = /^\^?(\d+)\.(\d+)(?:\.\d+)?$/.exec(s);
    return m ? `^${m[1]}.${m[2]}.0` : null;
}

/** The core entries a `pnpm-workspace.yaml` catalog carries, in order. */
export function catalogCoreEntries(ws) {
    const entries = [];
    let inCatalog = false;
    for (const line of ws.split('\n')) {
        if (/^(catalog|catalogs)\s*:/.test(line)) { inCatalog = true; continue; }
        // A column-0 COMMENT does not end the block — it is valid YAML anywhere inside
        // a mapping, and treating it as the end skipped every entry after it, so a wide
        // range sitting below a comment passed this guard silently. Same fix as
        // sync-core.mjs's walk; the two must agree or they disagree about what is aligned.
        if (inCatalog && line.trim() !== '' && !/^\s*#/.test(line) && /^\S/.test(line)) inCatalog = false;
        if (!inCatalog) continue;
        const m = entryRe.exec(line);
        if (!m) continue;
        const name = m[2];
        if (!CORE_PACKAGES.has(name)) continue;
        entries.push({ name, ver: m[3] ?? m[4] ?? m[5] });
    }
    return entries;
}

/**
 * Scan a `pnpm-workspace.yaml` and return catalog errors.
 *
 * Parsed leniently (the entries this cares about are simple `name: ^x.y.z`
 * lines) and only inside a `catalog:`/`catalogs:` block. Exported so the rules
 * can be unit-tested directly, the way `alignCatalog` is.
 *
 * @param {string} ws        contents of pnpm-workspace.yaml ('' if absent)
 * @param {string|null} want normalised caret to require, or null for structural-only
 */
export function checkCatalog(ws, want = null) {
    const errors = [];
    for (const { name, ver } of catalogCoreEntries(ws)) {
        if (!SINGLE_MINOR.test(ver)) {
            errors.push(`catalog["${name}"] = "${ver}" (must be single-minor ^X.Y.0 — or ^X.0.0-<pre> for a new major's prerelease — to keep one copy hoisted)`);
        } else if (want && ver !== want) {
            // Structurally fine but the WRONG minor — the failure mode check 2
            // cannot see. Name the remedy: this is what a missed sync looks like.
            const target = want.slice(1).replace(/^(\d+)\.(\d+)\.0$/, '$1.$2');
            errors.push(`catalog["${name}"] = "${ver}" (expected ${want} — run \`pnpm sync:core ${target}\`)`);
        }
    }
    return errors;
}

/**
 * The peer range the catalog implies (`peerRangeFor` of its first core pin), or
 * null when it has none — the manifest check then verifies peer shape only.
 */
export function catalogPeerRange(ws) {
    const first = catalogCoreEntries(ws)[0];
    return first ? peerRangeFor(first.ver) : null;
}

/** CLI entry. Returns the process exit code rather than exiting, so it is testable. */
export function main(argv = []) {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const arg = argv.find((a) => !a.startsWith('-'));

    let want = null;
    if (arg !== undefined) {
        want = normalizeExpected(arg);
        if (!want) {
            console.error(`verify:catalog: "${arg}" is not a version (expected X.Y, X.Y.Z or X.0.0-<pre>)`);
            return 2;
        }
    }

    const errors = [];

    // 2 + 3. A repo with no workspace file has no catalog to police.
    const wsPath = join(repoRoot, 'pnpm-workspace.yaml');
    const ws = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : '';
    errors.push(...checkCatalog(ws, want));

    // 1. Every manifest in the shape — peers judged against the catalog's pin.
    errors.push(...formatInlineCoreDeps(findInlineCoreDeps(repoRoot, catalogPeerRange(ws))));

    if (errors.length) {
        console.error('verify:catalog FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
        return 1;
    }
    console.log(
        want
            ? `verify:catalog OK — all core deps go through a single-minor catalog at ${want}, libraries peer on core.`
            : 'verify:catalog OK — all core deps go through a single-minor catalog, libraries peer on core.'
    );
    return 0;
}

// Only run when invoked directly, so the exports above stay importable in tests.
// Same guard shape as sync-core.mjs — the two are read side by side.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main(process.argv.slice(2)));
}
