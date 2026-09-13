// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildChildEnv, DEFAULT_ENV_ALLOWLIST, envKey } from '@sigx/ai-agent-node';

describe('buildChildEnv', () => {
    const base = { PATH: '/bin', HOME: '/home/a', SECRET_TOKEN: 'shh', NODE_OPTIONS: '--inspect', LANG: 'en', Path: 'C:\\Windows' };

    it('copies only the allowlist and never NODE_OPTIONS', () => {
        const env = buildChildEnv({ base, platform: 'linux' });
        expect(env).toEqual({ PATH: '/bin', HOME: '/home/a', LANG: 'en' });
        expect(DEFAULT_ENV_ALLOWLIST).toContain('PATH');
        expect(DEFAULT_ENV_ALLOWLIST).not.toContain('NODE_OPTIONS');
    });

    it('matches keys case-insensitively on Windows, keeping the base casing and the first duplicate', () => {
        const env = buildChildEnv({ base: { Path: 'C:\\Windows', TEMP: 'C:\\t', temp: 'dup', systemroot: 'C:\\Windows' }, platform: 'win32' });
        expect(env).toEqual({ Path: 'C:\\Windows', TEMP: 'C:\\t', systemroot: 'C:\\Windows' });
        expect(envKey({ Path: 'x' }, 'PATH', 'win32')).toBe('Path');
        expect(envKey({ Path: 'x' }, 'PATH', 'linux')).toBeUndefined();
    });

    it('extra adds, overrides (case-insensitively on Windows) and removes', () => {
        const env = buildChildEnv({ base: { Path: 'a', HOME: 'h' }, extra: { path: 'b', API_KEY: 'k', HOME: undefined }, platform: 'win32' });
        expect(env).toEqual({ path: 'b', API_KEY: 'k' });
        expect(buildChildEnv({ base: { PATH: 'a' }, extra: { NODE_OPTIONS: 'nope' }, platform: 'linux' })).toEqual({ PATH: 'a' });
    });

    it('inheritEnv copies everything except NODE_OPTIONS; a custom allowlist replaces the default', () => {
        expect(buildChildEnv({ base, inheritEnv: true, platform: 'linux' })).toEqual({ PATH: '/bin', HOME: '/home/a', SECRET_TOKEN: 'shh', LANG: 'en', Path: 'C:\\Windows' });
        expect(buildChildEnv({ base, allow: ['SECRET_TOKEN'], platform: 'linux' })).toEqual({ SECRET_TOKEN: 'shh' });
    });
});
