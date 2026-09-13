/** Coding policies — by category, and by where a tool wants to reach. */

import { rule, type Policy } from '../policy/index.js';
import type { CodingCategory } from './categories.js';
import { isWithin, normalizePath, resolveFrom, type NormalizedPath } from './paths.js';

/** Allows permissions whose `category` is listed; no opinion otherwise. */
export function allowCategories(categories: readonly CodingCategory[]): Policy {
    const set = new Set<string>(categories);
    return rule('allowCategories', (request) => (request.kind === 'permission' && request.category !== undefined && set.has(request.category) ? { type: 'permission', outcome: 'allow', scope: 'once' } : undefined));
}

export interface DenyOutsideOptions {
    readonly additionalDirectories?: readonly string[];
    /** Where to find paths in a tool's input; default: the usual keys. */
    readonly paths?: (input: unknown) => readonly string[];
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'cwd', 'directory', 'dir', 'target', 'destination', 'source', 'notebook_path', 'notebookPath', 'old_path', 'new_path'];
const LIST_KEYS = ['paths', 'files', 'additionalDirectories', 'additional_directories'];

/** Paths from the usual keys of a tool input (and `locations[].path`). */
export function pathsOf(input: unknown): string[] {
    if (typeof input !== 'object' || input === null) return [];
    const record = input as Record<string, unknown>;
    const out: string[] = [];
    for (const key of PATH_KEYS) if (typeof record[key] === 'string') out.push(record[key] as string);
    for (const key of LIST_KEYS) {
        const list = record[key];
        if (Array.isArray(list)) for (const v of list) if (typeof v === 'string') out.push(v);
    }
    const locations = record.locations;
    if (Array.isArray(locations)) for (const l of locations) if (typeof l === 'object' && l !== null && typeof (l as { path?: unknown }).path === 'string') out.push((l as { path: string }).path);
    return out;
}

/**
 * Denies a permission whose input names a path outside `cwd` (and the extra
 * directories); relative paths are resolved against `cwd`. No path in the
 * input → no opinion, so it composes: `firstMatch(denyOutside(cwd), allowCategories([...]))`.
 */
export function denyOutside(cwd: string, options: DenyOutsideOptions = {}): Policy {
    const roots: NormalizedPath[] = [cwd, ...(options.additionalDirectories ?? [])].map(normalizePath);
    const extract = options.paths ?? pathsOf;
    return rule('denyOutside', (request) => {
        if (request.kind !== 'permission') return undefined;
        for (const p of extract(request.input)) {
            const resolved = resolveFrom(cwd, p);
            if (!roots.some((r) => isWithin(resolved, r))) {
                return { type: 'permission', outcome: 'deny', scope: 'once', message: `Tool "${request.toolName ?? 'unknown'}" may not touch "${p}": it is outside the working directory.` };
            }
        }
        return undefined;
    });
}
