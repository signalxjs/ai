#!/usr/bin/env node
/**
 * sync-core.mjs — align this repo's pnpm catalog with a sigx core version.
 *
 * The sigx ecosystem pins core packages (`@sigx/reactivity`, …) to a SINGLE
 * minor so pnpm hoists exactly one physical copy — two copies break reactivity
 * (module-local reactive state). Each repo centralises those pins in the
 * `catalog:` block of `pnpm-workspace.yaml`, so a core bump is a one-line edit.
 *
 * This script performs that edit automatically:
 *   node scripts/sync-core.mjs            # align to the latest published core
 *   node scripts/sync-core.mjs 0.13.0     # align to an explicit version
 *   node scripts/sync-core.mjs 0.13       # minor is enough; patch is ignored
 *   node scripts/sync-core.mjs 1.0.0-rc.0 # a prerelease of a new major pins exactly
 *   node scripts/sync-core.mjs --check     # exit 1 if a change WOULD be made (CI drift guard)
 *
 * It rewrites only CORE packages (published from signalxjs/core) to `^X.Y.0`
 * (on 0.x `>=X.Y.0 <X.(Y+1).0`, one minor; from 1.0 the caret spans the major,
 * `>=X.Y.0 <(X+1).0.0` — either way the single-copy guarantee). It never
 * touches sibling-ecosystem entries (`@sigx/router`, `@sigx/lynx-*`, …) that may
 * also live in the catalog. Formatting is preserved (line-based edit). It does
 * NOT run install/build/test — CI (core-sync.yml) does that and opens the PR;
 * run those yourself when using it locally.
 *
 * It also writes THE SHAPE into every publishable package's manifest (core 1.0,
 * rfc-1.0 §3.3 — #53; the rules live in `lib/core-deps.mjs`): a core singleton
 * the library carries in `dependencies` moves to `peerDependencies` at the
 * peer range the catalog pin derives (`^X.0.0` on 1.x+, the catalog's own
 * `^0.Y.0` on 0.x, the exact caret while aligned to an rc) with a
 * `devDependencies: "catalog:"` twin, and an existing peer is re-pinned on a
 * major bump. The app that installs the library owns the single copy.
 *
 * It also rewrites the explanatory COMMENT that sits directly above the
 * `catalog:` block — the `# … ^X.Y.0 == >=X.Y.0 <X.(Y+1).0 …` prose (`<(X+1).0.0`
 * from 1.0) that names the pinned minor. Left alone it goes stale on every bump
 * (still citing the old minor), and Copilot's review flags it on every consumer,
 * turning an otherwise
 * clean catalog bump AMBER — a human forced in over a one-line comment. The
 * rewrite is doubly scoped: to the contiguous comment run immediately above the
 * header, and within it to only the version the catalog CURRENTLY pins — so an
 * unrelated caret sharing that block (a Node `^20.19.0` engines note, say) is
 * never touched, and a major bump still moves the old `^0.x` correctly (#41).
 *
 * Line endings are the file's own: both passes parse an LF-normalised copy and
 * write back with the EOL the file was read with, so a CRLF working tree (every
 * Windows checkout with `core.autocrlf=true`) round-trips byte-for-byte outside
 * the edited values (#55).
 *
 * Because it can ONLY rewrite catalog entries, it refuses to run in a repo whose
 * core deps are pinned inline instead: there would be nothing for the walk to
 * match, and reporting "already aligned" there is a false green that leaves the
 * repo on the old core with no signal at all. Convert those to `"catalog:"` first.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    CORE_PACKAGES,
    alignManifest,
    findInlineCoreDeps,
    formatInlineCoreDeps,
    peerRangeFor,
    workspaceManifests,
} from './lib/core-deps.mjs';

// Match catalog entries only while inside a `catalog:`/`catalogs:` block.
// A catalog entry line looks like:  <indent>"@sigx/reactivity": ^0.12.0
//                              or:  <indent>sigx: ^0.12.0
// The value may be double-quoted, single-quoted (and a quoted value may contain
// spaces, e.g. a wide range ">=0.11.0 <0.13.0" we want to tighten), or bare.
const blockHeader = /^(catalog|catalogs)\s*:/;
const entry = /^(\s+)(["']?)([@a-zA-Z0-9._/-]+)\2\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))(\s*(?:#.*)?)$/;

/**
 * Split a file's text into its LF-normalised form and the EOL it was written
 * with. Everything below parses and matches LF only: on a CRLF checkout a
 * `\s`-based match captures the `\r` (the manifest indent became `"\n    "`
 * and every rewritten line gained a blank one), and a line-anchored `$` after
 * `.*` never matches with a `\r` left before it (#55).
 *
 * @param {string} src
 * @returns {{ text: string, eol: '\n' | '\r\n' }}
 */
export function normalizeEol(src) {
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    return { text: src.replace(/\r\n/g, '\n'), eol };
}

/** Re-emit LF text with `eol` — the inverse of `normalizeEol`. */
const restoreEol = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));

/** Escape a string for literal use inside a `RegExp`. */
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Call `cb(name, ver)` for every entry inside a `catalog:`/`catalogs:` block —
 * the read-only walk, used to learn which core version the catalog currently
 * pins. The write-side walk in `alignCatalog` uses the same block-termination
 * rule (a comment never ends the block); the two must agree.
 */
function forEachCatalogEntry(lines, cb) {
    let inCatalog = false;
    let catalogIndent = -1;
    for (const line of lines) {
        if (blockHeader.test(line)) {
            inCatalog = true;
            catalogIndent = line.search(/\S/);
            continue;
        }
        if (inCatalog) {
            const indent = line.search(/\S/);
            if (line.trim() !== '' && !/^\s*#/.test(line) && indent <= catalogIndent && !entry.test(line)) inCatalog = false;
        }
        if (!inCatalog) continue;
        const m = entry.exec(line);
        if (m) cb(m[3], m[4] ?? m[5] ?? m[6]);
    }
}

/**
 * Align a `pnpm-workspace.yaml`'s core catalog pins — and the explanatory
 * comment above them — to `range`. Pure text transform: no I/O, no process exit,
 * so both the CLI below and the unit tests drive the same code.
 *
 * @param {string} src   the pnpm-workspace.yaml contents
 * @param {string} range the target caret: single-minor `^X.Y.0`, or the exact `^X.0.0-<pre>` of a new major's prerelease
 * @returns {{ text: string, pins: {name:string,from:string,to:string}[], comments: {from:string,to:string}[] }}
 */
export function alignCatalog(src, range) {
    // ^X.Y.0, or — for a prerelease of a new major, the only caret that resolves
    // it — ^X.0.0-<pre>; check-catalog.mjs's SINGLE_MINOR accepts the same two.
    const rm = /^\^(\d+)\.(\d+)\.0(-[0-9A-Za-z.-]+)?$/.exec(range);
    if (!rm || (rm[3] && rm[2] !== '0')) {
        throw new Error(`alignCatalog: range must be a single-minor caret ^X.Y.0 (or ^X.0.0-<pre>), got "${range}"`);
    }
    const tMaj = Number(rm[1]);
    const tMin = Number(rm[2]);
    const tPre = rm[3] ?? '';
    const targetCaret = `^${tMaj}.${tMin}.0${tPre}`; // == range, rebuilt from parts for clarity
    // The equivalent explicit range. A caret is one MINOR only while the major
    // is 0 (`^0.13.0` == `>=0.13.0 <0.14.0`); from 1.0 it is the whole major
    // (`^1.3.0` == `>=1.3.0 <2.0.0`, and so is `^1.0.0-rc.0`) — which is the
    // point of 1.0: additive minors, one copy across the line.
    const targetWide = tMaj === 0
        ? `>=0.${tMin}.0 <0.${tMin + 1}.0`
        : `>=${tMaj}.${tMin}.0${tPre} <${tMaj + 1}.0.0`;

    const { text: lf, eol } = normalizeEol(src);
    const lines = lf.split('\n');

    // The explanatory comment is the contiguous run of `#` lines immediately
    // above a `catalog:`/`catalogs:` header. Its version prose is the only prose
    // we touch, and even there only the tokens naming the minor the catalog
    // CURRENTLY pins — see `commentSubs` below.
    const commentLines = new Set();
    for (let i = 0; i < lines.length; i++) {
        if (blockHeader.test(lines[i])) {
            for (let j = i - 1; j >= 0 && /^\s*#/.test(lines[j]); j--) commentLines.add(j);
        }
    }

    // Which minor(s) is the catalog on right now? We rewrite ONLY those tokens in
    // the comment, keyed on the version the catalog itself declares — never "any
    // caret". An unrelated version sharing that comment block (a Node `^20.19.0`
    // engines note, say) matches no current core pin and is left alone, so the
    // safety claim holds even across a major bump: the current `^0.12.0` is
    // rewritten, a `^20.x` is not.
    const commentSubs = [];
    const seenMinor = new Set();
    forEachCatalogEntry(lines, (name, ver) => {
        if (!CORE_PACKAGES.has(name)) return;
        // Lower bound of a caret or a wide range, prerelease suffix included: an
        // rc pin (`^1.0.0-rc.0`) is a DIFFERENT pin from `^1.0.0` and must be
        // rewritten when 1.0.0 ships, although both are major 1 minor 0.
        const vm = /(\d+)\.(\d+)(?:\.\d+)?(-[0-9A-Za-z.-]+)?/.exec(ver);
        if (!vm) return;
        const maj = Number(vm[1]);
        const min = Number(vm[2]);
        const pre = vm[3] ?? '';
        const key = `${maj}.${min}${pre}`;
        if ((maj === tMaj && min === tMin && pre === tPre) || seenMinor.has(key)) return; // target, or already collected
        seenMinor.add(key);
        // Explicit range first (it contains no caret, so it can't collide with the
        // caret pass); then the bare caret. Both forms name the same pinned minor.
        // The upper bound is the next minor on 0.x and the next major from 1.0 —
        // both are matched, so a comment written for either era is rewritten.
        commentSubs.push({
            wide: new RegExp(
                `>=\\s*${reEscape(`${maj}.${min}`)}(?:\\.\\d+)?${pre ? reEscape(pre) : ''}\\s*<\\s*(?:${maj}\\.${min + 1}|${maj + 1}\\.0)(?:\\.\\d+)?`,
                'g',
            ),
            caret: new RegExp(`\\^${reEscape(`${maj}.${min}`)}(?:\\.\\d+)?${pre ? reEscape(pre) : ''}`, 'g'),
        });
    });

    let inCatalog = false;
    let catalogIndent = -1;
    const pins = [];
    const comments = [];

    const out = lines.map((line, idx) => {
        // --- explanatory-comment rewrite ---------------------------------------
        if (commentLines.has(idx) && commentSubs.length) {
            let next = line;
            for (const sub of commentSubs) next = next.replace(sub.wide, targetWide).replace(sub.caret, targetCaret);
            if (next !== line) comments.push({ from: line.trim(), to: next.trim() });
            return next;
        }

        // --- catalog pin rewrite -----------------------------------------------
        if (blockHeader.test(line)) {
            inCatalog = true;
            catalogIndent = line.search(/\S/);
            return line;
        }
        if (inCatalog) {
            const indent = line.search(/\S/);
            // A non-blank, non-COMMENT line at or below the block header's indent ends
            // the block. Comments are excluded deliberately: a `# …` at column 0 is
            // valid YAML anywhere inside a mapping, and treating it as the end silently
            // dropped every entry after it — the catalogs in this org are commented, so
            // sync:core would rewrite the first few pins, report success, and leave the
            // rest on the old minor. A partially-aligned catalog is the two-copies
            // hazard the single-minor rule exists to prevent.
            if (line.trim() !== '' && !/^\s*#/.test(line) && indent <= catalogIndent && !entry.test(line)) {
                inCatalog = false;
            }
        }
        if (!inCatalog) return line;

        const m = entry.exec(line);
        if (!m) return line;
        const [, ind, nameQ, name, dqVal, sqVal, uqVal, trailing] = m;
        if (!CORE_PACKAGES.has(name)) return line; // leave sibling entries alone
        const ver = dqVal ?? sqVal ?? uqVal;
        const valQ = dqVal !== undefined ? '"' : sqVal !== undefined ? "'" : '';
        if (ver === range) return line; // already aligned
        pins.push({ name, from: ver, to: range });
        return `${ind}${nameQ}${name}${nameQ}: ${valQ}${range}${valQ}${trailing ?? ''}`;
    });

    return { text: restoreEol(out.join('\n'), eol), pins, comments };
}

/** Resolve the target minor as `^X.Y.0`, from an arg or the npm registry. */
function resolveRange(versionArg) {
    let v = versionArg;
    if (!v) {
        // Offline, a registry outage or an auth problem would otherwise surface as a
        // raw execSync stack trace — noise in a CI log, and it buries the one useful
        // instruction (pass the version explicitly).
        try {
            v = execSync('npm view @sigx/reactivity version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        } catch (err) {
            console.error(
                'sync-core: could not read the latest core version from npm ' +
                    `(${String(err.message).split('\n')[0]}).\n` +
                    'Pass the target explicitly instead: node scripts/sync-core.mjs X.Y',
            );
            process.exit(2);
        }
    }
    // A prerelease of a NEW MAJOR (1.0.0-rc.0) pins exactly: `^1.0.0` would not
    // resolve it, and `^1.0.0-rc.0` keeps matching rc.1 and 1.0.0 itself. Any
    // other prerelease (1.1.0-beta.0, 0.16.0-rc.0) aligns to its minor as a
    // release would — consumers align to releases; the rc case exists only
    // because a major's first release has no stable version to pin.
    const pre = /^v?(\d+)\.0\.0(-[0-9A-Za-z.-]+)$/.exec(v);
    if (pre) return { range: `^${pre[1]}.0.0${pre[2]}`, display: `${pre[1]}.0.0${pre[2]}` };
    const m = /^v?(\d+)\.(\d+)/.exec(v);
    if (!m) {
        console.error(`sync-core: cannot parse a version from "${v}"`);
        process.exit(2);
    }
    return { range: `^${m[1]}.${m[2]}.0`, display: `${m[1]}.${m[2]}` };
}

/**
 * Rewrite every publishable manifest under `repoRoot` to the shape for
 * `peerRange` (`alignManifest`), preserving each file's indentation, line
 * endings and trailing newline (or its absence). Returns
 * the change lines; writes nothing when `dryRun`.
 */
export function alignManifests(repoRoot, peerRange, { dryRun = false } = {}) {
    const changes = [];
    for (const file of workspaceManifests(repoRoot)) {
        const { text: src, eol } = normalizeEol(readFileSync(file, 'utf8'));
        const pkg = JSON.parse(src);
        const result = alignManifest(pkg, peerRange);
        if (result.changes.length === 0) continue;
        changes.push(...result.changes);
        if (dryRun) continue;
        // `[ \t]`, never `\s`: `\s` also matches a newline, so a CRLF (or a
        // blank line) would leak into the indent and every emitted line would
        // gain a blank one (#55, signalxjs/richtext#40).
        const indent = /^([ \t]+)"/m.exec(src)?.[1] ?? '  ';
        const trailing = src.endsWith('\n') ? '\n' : '';
        writeFileSync(file, restoreEol(JSON.stringify(result.pkg, null, indent) + trailing, eol));
    }
    return changes;
}

/** CLI entry point — all the I/O and process-exit side effects live here. */
function main() {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const wsPath = join(repoRoot, 'pnpm-workspace.yaml');

    const args = process.argv.slice(2);
    const checkOnly = args.includes('--check');
    const versionArg = args.find((a) => !a.startsWith('-'));

    if (!existsSync(wsPath)) {
        console.error(`sync-core: no pnpm-workspace.yaml at ${wsPath}`);
        process.exit(2);
    }

    // Refuse to run against INLINE core pins — a literal version where "catalog:"
    // is required. This script aligns the catalog and moves "catalog:" deps
    // between fields; it will not guess which catalog entry a hand-written
    // `^0.12.0` meant, and a repo whose core deps are all inline has nothing for
    // the walk below to match — it would print "already aligned" and exit 0 while
    // leaving the repo on the old core. That false green is worse than no tooling:
    // core-sync.yml swallows it as success and opens no PR. (Shape drift — a
    // singleton still in `dependencies`, a peer at the old range — is what the
    // manifest pass below fixes, so it is not refused here.)
    const inline = findInlineCoreDeps(repoRoot).filter((h) => h.kind === 'inline');
    if (inline.length) {
        console.error(
            'sync-core: this repo pins core packages INLINE, outside the catalog:\n' +
                formatInlineCoreDeps(inline)
                    .map((l) => '  - ' + l)
                    .join('\n') +
                '\n\nsync:core can only rewrite catalog entries, so it cannot align this repo.' +
                '\nAdd the packages above to the `catalog:` block of pnpm-workspace.yaml and' +
                '\nreplace each specifier with "catalog:", then re-run. `pnpm verify:catalog`' +
                '\nchecks the same thing on every CI run.',
        );
        process.exit(1);
    }

    const { range, display } = resolveRange(versionArg);
    const src = readFileSync(wsPath, 'utf8');
    const { text, pins, comments } = alignCatalog(src, range);
    // The manifest pass is a dry run first: report everything, then write both.
    const manifests = alignManifests(repoRoot, peerRangeFor(range), { dryRun: true });

    if (pins.length === 0 && comments.length === 0 && manifests.length === 0) {
        console.log(`sync-core: catalog and manifests already aligned to core ${display} (no change).`);
        process.exit(0);
    }

    console.log(`sync-core: align to core ${display}:`);
    for (const c of pins) console.log(`  ${c.name}: ${c.from} -> ${c.to}`);
    for (const c of comments) console.log(`  comment: ${c.from} -> ${c.to}`);
    for (const c of manifests) console.log(`  ${c}`);

    if (checkOnly) {
        console.error('sync-core: --check found drift (see above). Run without --check to apply.');
        process.exit(1);
    }

    if (pins.length || comments.length) writeFileSync(wsPath, text);
    alignManifests(repoRoot, peerRangeFor(range));
    console.log(`\nsync-core: wrote ${wsPath}${manifests.length ? ' and the package manifests above' : ''}. Next: pnpm install && pnpm build && pnpm typecheck && pnpm test`);
}

// Run the CLI only when executed directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
