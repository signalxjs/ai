/**
 * Executable resolution that works on Windows.
 *
 * `PATH` is `Path` there, executables carry `PATHEXT` extensions, and an
 * npm-installed CLI is a `.cmd` shim Node refuses to spawn without a shell
 * (CVE-2024-27980 hardening). The shim is a tiny batch file that runs a JS
 * entry with node; we read it and run that entry with `process.execPath`
 * ourselves, so no shell is involved. Only a shim we cannot parse falls back
 * to `cmd.exe`, which `spawn.ts` drives with strict quoting.
 */

import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { envKey } from './env.js';

export type ExecutableKind = 'native' | 'node-script' | 'cmd-shim';

export interface ResolvedExecutable {
    /** The file that was found on disk. */
    readonly path: string;
    /** What to spawn: the file itself, or `process.execPath` for a script; for a `cmd-shim` the shim, which `spawnAgentProcess` runs through `cmd.exe`. */
    readonly command: string;
    /** Arguments to put BEFORE the caller's own. */
    readonly args: readonly string[];
    /** Environment the executable needs (a pnpm shim's `NODE_PATH`). */
    readonly env?: Readonly<Record<string, string>>;
    readonly kind: ExecutableKind;
}

export interface ResolveExecutableOptions {
    /** Default `process.env`. */
    readonly env?: NodeJS.ProcessEnv;
    /** Base for a relative `name` that contains a separator; never searched for a bare name. */
    readonly cwd?: string;
    /** Default `process.platform`. */
    readonly platform?: NodeJS.Platform;
    /** Default `process.execPath`. */
    readonly nodePath?: string;
}

export class ExecutableNotFoundError extends Error {
    override readonly name = 'ExecutableNotFoundError';
    constructor(
        readonly executable: string,
        readonly searched: readonly string[]
    ) {
        super(`[sigx ai-agent-node] executable "${executable}" not found${searched.length ? ` (searched: ${searched.join(', ')})` : ''}`);
    }
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs']);

async function exists(file: string, executable: boolean): Promise<boolean> {
    try {
        const s = await stat(file);
        if (!s.isFile()) return false;
        // A script runs under node; it needs no execute bit of its own.
        if (executable && !SCRIPT_EXT.has(extname(file).toLowerCase())) await access(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export async function resolveExecutable(name: string, options: ResolveExecutableOptions = {}): Promise<ResolvedExecutable> {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const win = platform === 'win32';
    const nodePath = options.nodePath ?? process.execPath;
    const hasSeparator = name.includes('/') || (win && name.includes('\\'));

    const pathextKey = win ? envKey(env, 'PATHEXT', platform) : undefined;
    // Lower-cased: Windows does not care, and the path we report should look
    // like the file on disk (`tool.cmd`, not `tool.CMD` from PATHEXT).
    const exts = win
        ? (pathextKey ? env[pathextKey]! : DEFAULT_PATHEXT)
              .split(';')
              .filter(Boolean)
              .map((e) => e.toLowerCase())
        : [];

    const candidates: string[] = [];
    if (hasSeparator) {
        const base = isAbsolute(name) ? name : resolve(options.cwd ?? process.cwd(), name);
        candidates.push(base);
        if (win && !extname(base)) for (const e of exts) candidates.push(base + e);
    } else {
        const pathKey = envKey(env, 'PATH', platform);
        const dirs = (pathKey ? env[pathKey]! : '').split(win ? ';' : delimiter).filter(Boolean);
        for (const dir of dirs) {
            const base = join(dir, name);
            if (win) {
                if (extname(name)) candidates.push(base);
                for (const e of exts) candidates.push(base + e);
                if (!extname(name)) candidates.push(base);
            } else candidates.push(base);
        }
    }

    for (const file of candidates) {
        if (!(await exists(file, !win))) continue;
        return classify(file, { win, nodePath, env });
    }
    throw new ExecutableNotFoundError(name, candidates.map((c) => dirname(c)).filter((d, i, a) => a.indexOf(d) === i));
}

async function classify(file: string, ctx: { win: boolean; nodePath: string; env: NodeJS.ProcessEnv }): Promise<ResolvedExecutable> {
    const ext = extname(file).toLowerCase();
    if (SCRIPT_EXT.has(ext)) return { path: file, command: ctx.nodePath, args: [file], kind: 'node-script' };
    if (ctx.win && (ext === '.cmd' || ext === '.bat')) {
        const shim = await parseCmdShim(file);
        if (shim) return { path: file, command: ctx.nodePath, args: [shim.script], ...(shim.env ? { env: shim.env } : {}), kind: 'node-script' };
        // `command` stays the shim: `spawnAgentProcess` wraps it in `cmd.exe /d /s /c`
        // (so `spawnAgentProcess({ ...resolved, args: [...resolved.args, ...more] })` works).
        return { path: file, command: file, args: [], kind: 'cmd-shim' };
    }
    return { path: file, command: file, args: [], kind: 'native' };
}

const NODE_PROGRAMS = new Set(['node', 'node.exe', '"%~dp0\\node.exe"', '"%dp0%\\node.exe"', '"%_prog%"', '%_prog%']);

/**
 * The JS entry an npm/pnpm `.cmd` shim runs, or `undefined` when the shim
 * has another shape. Looks at the line that forwards `%*`, takes its last
 * double-quoted token containing `dp0`, expands `%~dp0` / `%dp0%` to the
 * shim's directory, and checks the file exists.
 */
export async function parseCmdShim(file: string): Promise<{ script: string; env?: Record<string, string> } | undefined> {
    let text: string;
    try {
        const handle = await readFile(file);
        if (handle.byteLength > 8192) return undefined;
        text = handle.toString('utf8');
    } catch {
        return undefined;
    }
    const dir = dirname(file);
    // The shim's own separators are backslashes; the host's may not be (the
    // parser is exercised on every OS in tests), so both become the host's.
    const expand = (s: string) => s.replace(/%~dp0\\?/gi, dir + sep).replace(/%dp0%\\?/gi, dir + sep).replace(/\\/g, sep);
    let script: string | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.endsWith('%*')) continue;
        // npm's shim chains its command after `endLocal & goto … || title … &`;
        // the program is the first token of the LAST command in the chain.
        const command = line.split(/\s*(?:&&|\|\||&|\|)\s*/).pop() ?? line;
        const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
        const program = tokens[0]?.replace(/^@/, '') ?? '';
        if (!NODE_PROGRAMS.has(program.toLowerCase()) && !NODE_PROGRAMS.has(program)) return undefined;
        const quoted = tokens.filter((t) => t.startsWith('"') && /dp0/i.test(t));
        const last = quoted[quoted.length - 1];
        if (!last) return undefined;
        script = resolve(expand(last.slice(1, -1)));
        break;
    }
    if (!script || !(await exists(script, false))) return undefined;
    const nodePath = /@SET "NODE_PATH=([^"]*)"/i.exec(text)?.[1];
    return { script, ...(nodePath ? { env: { NODE_PATH: nodePath.replace(/;%NODE_PATH%$/i, '') } } : {}) };
}
