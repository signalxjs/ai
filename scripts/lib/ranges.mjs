/**
 * In-repo dependency ranges — the caret every workspace package declares on
 * its siblings (`"@sigx/ai": "^0.1.0"` in a provider's `peerDependencies`).
 *
 * Shared by `bump-version.js` (rewrites them on a bump) and `verify-pack.js`
 * (refuses to pack when one is stale). A hand-rolled caret check: no `semver`
 * dependency at the repo root, and in-repo ranges are plain carets by
 * convention — anything else is a mistake this file surfaces.
 */

/** Pack-time specifiers `pnpm pack` rewrites — never ours to touch. */
export function isPackTimeSpecifier(spec) {
    return typeof spec === 'string' && (spec.startsWith('workspace:') || spec.startsWith('catalog:'));
}

/** `[major, minor, patch]` of a release version; prereleases and builds are not versions this file reasons about. */
function parse(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The caret range a dependent should declare on `version`: `^X.0.0` from 1.0,
 * `^0.Y.0` below it — and `^0.0.Z` for 0.0.x, where a caret pins the patch.
 */
export function caretRange(version) {
    const v = parse(version);
    if (!v) throw new Error(`not a version: ${version}`);
    if (v[0] > 0) return `^${v[0]}.0.0`;
    return v[1] > 0 ? `^0.${v[1]}.0` : `^0.0.${v[2]}`;
}

/** `true` when `version` lies inside the plain caret `range` (`^X.Y.Z`). Non-carets are never satisfied. */
export function satisfiesCaret(range, version) {
    if (typeof range !== 'string' || !range.startsWith('^')) return false;
    const r = parse(range.slice(1));
    const v = parse(version);
    if (!r || !v) return false;
    if (r[0] === 0) {
        if (v[0] !== 0 || v[1] !== r[1]) return false;
        // ^0.0.Z → exactly 0.0.Z; ^0.Y.Z (Y > 0) → >=0.Y.Z <0.(Y+1).0
        return r[1] === 0 ? v[2] === r[2] : v[2] >= r[2];
    }
    // ^X.Y.Z → >=X.Y.Z <(X+1).0.0
    if (v[0] !== r[0]) return false;
    return v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]);
}

const RANGE_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Every in-repo range in `dependencies` / `peerDependencies` /
 * `optionalDependencies` must satisfy the sibling's current version, or the
 * packed tarballs cannot install together. Throws on the first stale one.
 * `manifests` are parsed `package.json` objects of the packages being packed.
 */
export function assertInRepoRanges(manifests) {
    const versions = new Map(manifests.map((m) => [m.name, m.version]));
    for (const pkg of manifests) {
        for (const field of RANGE_FIELDS) {
            for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
                const version = versions.get(dep);
                if (version === undefined || isPackTimeSpecifier(spec)) continue;
                if (!satisfiesCaret(spec, version)) {
                    throw new Error(
                        `${pkg.name} ${field}.${dep} = ${spec} does not satisfy ${version} — run \`pnpm version:set ${version}\` (or a bump) so dependents follow`
                    );
                }
            }
        }
    }
}
