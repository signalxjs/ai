import { describe, it, expect } from 'vitest';
import { createGrants, firstMatch, type PolicyContext, type PolicyRequest } from '@sigx/ai-agent';
import { allowCategories, denyOutside, pathsOf } from '@sigx/ai-agent/coding';

const ctx: PolicyContext = { sessionId: 's', interactive: false, grants: createGrants(), signal: new AbortController().signal };
const perm = (toolName: string, input: unknown, category?: string): PolicyRequest => ({ kind: 'permission', toolName, input, source: 'native', ...(category ? { category } : {}) });

describe('coding policies', () => {
    it('allowCategories allows listed categories and has no opinion otherwise', async () => {
        const policy = allowCategories(['read', 'search']);
        expect(await policy(perm('Read', {}, 'read'), ctx)).toMatchObject({ outcome: 'allow' });
        expect(await policy(perm('Bash', {}, 'execute'), ctx)).toBeUndefined();
        expect(await policy(perm('X', {}), ctx)).toBeUndefined();
        expect(await policy({ kind: 'input', source: 'native' }, ctx)).toBeUndefined();
    });

    it('pathsOf finds the usual keys', () => {
        expect(pathsOf({ file_path: '/a', paths: ['/b', '/c'], locations: [{ path: '/d' }], other: '/e' })).toEqual(['/a', '/b', '/c', '/d']);
        expect(pathsOf('nope')).toEqual([]);
    });

    it('denyOutside denies paths outside cwd (POSIX, Windows, UNC), resolves relative ones, composes', async () => {
        const posix = denyOutside('/home/andy/repo', { additionalDirectories: ['/tmp/scratch'] });
        expect(await posix(perm('Edit', { file_path: '/home/andy/repo/src/a.ts' }), ctx)).toBeUndefined();
        expect(await posix(perm('Edit', { file_path: 'src/a.ts' }), ctx)).toBeUndefined();
        expect(await posix(perm('Edit', { file_path: '../secrets' }), ctx)).toMatchObject({ outcome: 'deny', message: expect.stringContaining('../secrets') });
        expect(await posix(perm('Edit', { file_path: '/etc/passwd' }), ctx)).toMatchObject({ outcome: 'deny' });
        expect(await posix(perm('Read', { path: '/tmp/scratch/x' }), ctx)).toBeUndefined();
        expect(await posix(perm('Bash', { command: 'ls' }), ctx)).toBeUndefined();

        const win = denyOutside('C:\\Users\\andy\\My Repo');
        expect(await win(perm('Edit', { file_path: 'c:/users/ANDY/my repo/src/a.ts' }), ctx)).toBeUndefined();
        expect(await win(perm('Edit', { file_path: 'C:\\Users\\andy\\Other' }), ctx)).toMatchObject({ outcome: 'deny' });
        expect(await win(perm('Edit', { file_path: 'src\\..\\..\\Other' }), ctx)).toMatchObject({ outcome: 'deny' });
        expect(await win(perm('Edit', { file_path: 'D:\\Users\\andy\\My Repo\\a' }), ctx)).toMatchObject({ outcome: 'deny' });
        expect(await win(perm('Edit', { file_path: 'D:src\\a.ts' }), ctx)).toMatchObject({ outcome: 'deny' });
        expect(await win(perm('Edit', { file_path: 'C:src\\a.ts' }), ctx)).toBeUndefined();

        const unc = denyOutside('\\\\server\\share\\repo');
        expect(await unc(perm('Read', { path: '//server/share/repo/a' }), ctx)).toBeUndefined();
        expect(await unc(perm('Read', { path: '\\\\server\\share\\other' }), ctx)).toMatchObject({ outcome: 'deny' });

        const composed = firstMatch(denyOutside('/repo'), allowCategories(['edit']));
        expect(await composed(perm('Edit', { file_path: '/repo/a' }, 'edit'), ctx)).toMatchObject({ outcome: 'allow', ruleId: 'allowCategories' });
        expect(await composed(perm('Edit', { file_path: '/x' }, 'edit'), ctx)).toMatchObject({ outcome: 'deny', ruleId: 'denyOutside' });
    });

    it('a custom path extractor replaces the default', async () => {
        const policy = denyOutside('/repo', { paths: (input) => [(input as { target: string }).target] });
        expect(await policy(perm('X', { target: '/repo/ok', file_path: '/elsewhere' }), ctx)).toBeUndefined();
        expect(await policy(perm('X', { target: '/elsewhere' }), ctx)).toMatchObject({ outcome: 'deny' });
    });
});
