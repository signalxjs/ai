/**
 * A small pure path normaliser — enough to answer "is this path inside that
 * directory?" for POSIX, Windows drive-letter and UNC paths, on any runtime
 * (no `node:path`: this entry is edge-safe and a policy may judge paths for a
 * machine other than the one it runs on).
 */

export interface NormalizedPath {
    /** `''` for POSIX, `C:` for a drive, `\\server\share` for a UNC share (lower-cased). */
    readonly root: string;
    readonly segments: readonly string[];
    readonly windows: boolean;
    readonly absolute: boolean;
}

const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;
const UNC = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)/;

/** Windows when it has a drive letter, a UNC prefix, or any backslash. */
export function isWindowsPath(path: string): boolean {
    return DRIVE.test(path) || UNC.test(path) || path.includes('\\');
}

export function normalizePath(path: string): NormalizedPath {
    const windows = isWindowsPath(path);
    let root = '';
    let rest = path;
    let absolute = false;
    if (windows) {
        const unc = UNC.exec(path);
        if (unc) {
            root = `\\\\${unc[1]!.toLowerCase()}\\${unc[2]!.toLowerCase()}`;
            rest = path.slice(unc[0].length);
            absolute = true;
        } else if (DRIVE.test(path)) {
            root = path.slice(0, 2).toUpperCase();
            rest = path.slice(2);
            absolute = /^[\\/]/.test(rest);
        } else if (/^[\\/]/.test(path)) {
            // Rooted on the current drive — absolute within an unknown drive.
            absolute = true;
        }
    } else if (path.startsWith('/')) {
        absolute = true;
    }
    const segments: string[] = [];
    for (const raw of rest.split(/[\\/]+/)) {
        const seg = windows ? raw.toLowerCase() : raw;
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            // Above the root of an absolute path there is nothing to climb to; a
            // relative path keeps its leading `..` so `resolveFrom` can climb the base.
            if (segments.length && segments[segments.length - 1] !== '..') segments.pop();
            else if (!absolute) segments.push('..');
            continue;
        }
        segments.push(seg);
    }
    return { root, segments, windows, absolute };
}

/** `child` resolved against `base` when it is relative; an absolute child stands on its own (a drive-less Windows root borrows the base's drive). */
export function resolveFrom(base: string, child: string): NormalizedPath {
    const c = normalizePath(child);
    const b = normalizePath(base);
    if (c.absolute) return c.windows && !c.root ? { ...c, root: b.root } : c;
    const segments = [...b.segments];
    for (const seg of c.segments) {
        if (seg === '..') {
            if (segments.length) segments.pop();
        } else segments.push(seg);
    }
    return { root: b.root, segments, windows: b.windows, absolute: b.absolute };
}

/** `path` is `dir` or inside it (case-insensitive on Windows, `..` resolved). */
export function isWithin(path: string | NormalizedPath, dir: string | NormalizedPath): boolean {
    const p = typeof path === 'string' ? normalizePath(path) : path;
    const d = typeof dir === 'string' ? normalizePath(dir) : dir;
    if (!p.absolute || !d.absolute) return false;
    if (p.root !== d.root) return false;
    if (p.segments.length < d.segments.length) return false;
    for (let i = 0; i < d.segments.length; i++) if (p.segments[i] !== d.segments[i]) return false;
    return true;
}
