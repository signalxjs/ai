/**
 * The child environment — an allowlist, not an inheritance.
 *
 * A harness process gets what it needs to find executables, its home and
 * config directories, temp space, locale and proxies — plus whatever the
 * caller adds explicitly (an API key, a config dir). Everything else in the
 * parent's environment stays out unless `inheritEnv: true` says otherwise.
 * `NODE_OPTIONS` is never passed through: it would reach into every Node
 * child (including the harness itself) with the parent's flags.
 */

/** Variables a harness needs on any OS; matched case-insensitively on Windows. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'TMP',
    'TEMP',
    'TMPDIR',
    'SystemRoot',
    'windir',
    'ComSpec',
    'SystemDrive',
    'USERNAME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'COLORTERM',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR'
];

const NEVER = new Set(['node_options']);

export interface BuildChildEnvOptions {
    /** The parent environment; default `process.env`. */
    readonly base?: NodeJS.ProcessEnv;
    /** Names to copy from `base`; default `DEFAULT_ENV_ALLOWLIST`. */
    readonly allow?: readonly string[];
    /** Added (or, with `undefined`, removed) after the allowlist. */
    readonly extra?: Readonly<Record<string, string | undefined>>;
    /** Copy the whole base environment (still minus `NODE_OPTIONS`). */
    readonly inheritEnv?: boolean;
    /** Default `process.platform`. */
    readonly platform?: NodeJS.Platform;
}

/** Look a variable up by name — case-insensitively on Windows, where `Path` and `PATH` are one variable. */
export function envKey(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
    if (name in env) return name;
    if (platform !== 'win32') return undefined;
    const lower = name.toLowerCase();
    for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return key;
    return undefined;
}

export function buildChildEnv(options: BuildChildEnvOptions = {}): Record<string, string> {
    const platform = options.platform ?? process.platform;
    const base = options.base ?? process.env;
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    const fold = (k: string) => (platform === 'win32' ? k.toLowerCase() : k);
    const put = (key: string, value: string | undefined) => {
        if (value === undefined || NEVER.has(key.toLowerCase())) return;
        const f = fold(key);
        // Duplicates that differ only by case collapse to the first one seen.
        if (seen.has(f)) return;
        seen.add(f);
        out[key] = value;
    };
    if (options.inheritEnv) {
        for (const [k, v] of Object.entries(base)) put(k, v);
    } else {
        for (const name of options.allow ?? DEFAULT_ENV_ALLOWLIST) {
            const key = envKey(base, name, platform);
            if (key !== undefined) put(key, base[key]);
        }
    }
    for (const [k, v] of Object.entries(options.extra ?? {})) {
        const existing = envKey(out, k, platform);
        if (existing !== undefined) {
            delete out[existing];
            seen.delete(fold(existing));
        }
        if (v !== undefined) put(k, v);
    }
    return out;
}
