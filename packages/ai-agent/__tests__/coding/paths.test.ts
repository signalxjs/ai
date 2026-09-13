import { describe, it, expect } from 'vitest';
import { normalizePath, isWithin, resolveFrom, isWindowsPath } from '@sigx/ai-agent/coding';

describe('pure path normaliser', () => {
    it('detects Windows flavours', () => {
        expect(isWindowsPath('C:\\x')).toBe(true);
        expect(isWindowsPath('c:/x')).toBe(true);
        expect(isWindowsPath('\\\\server\\share\\x')).toBe(true);
        expect(isWindowsPath('/home/a')).toBe(false);
    });

    it('normalises drives (case-insensitive, either separator), UNC shares and POSIX', () => {
        expect(normalizePath('C:\\Users\\Andy\\..\\andy\\.\\Repo')).toEqual({ root: 'C:', segments: ['users', 'andy', 'repo'], windows: true, absolute: true });
        expect(normalizePath('c:/Users/andy/repo/')).toEqual({ root: 'C:', segments: ['users', 'andy', 'repo'], windows: true, absolute: true });
        expect(normalizePath('\\\\Server\\Share\\Dir\\file.txt')).toEqual({ root: '\\\\server\\share', segments: ['dir', 'file.txt'], windows: true, absolute: true });
        expect(normalizePath('//server/share/dir')).toEqual({ root: '\\\\server\\share', segments: ['dir'], windows: true, absolute: true });
        // The share itself, with or without a trailing separator, is a root.
        expect(normalizePath('\\\\server\\share')).toEqual({ root: '\\\\server\\share', segments: [], windows: true, absolute: true });
        expect(normalizePath('//server/share/')).toEqual({ root: '\\\\server\\share', segments: [], windows: true, absolute: true });
        expect(isWithin('\\\\server\\share\\x', '\\\\server\\share')).toBe(true);
        expect(isWithin('\\\\server\\share', '\\\\server\\share')).toBe(true);
        expect(normalizePath('/home/andy/Repo/../repo/src')).toEqual({ root: '', segments: ['home', 'andy', 'repo', 'src'], windows: false, absolute: true });
        expect(normalizePath('src/../lib')).toEqual({ root: '', segments: ['lib'], windows: false, absolute: false });
        expect(normalizePath('../../lib/../x')).toEqual({ root: '', segments: ['..', '..', 'x'], windows: false, absolute: false });
        expect(normalizePath('/a/../../b')).toEqual({ root: '', segments: ['b'], windows: false, absolute: true });
    });

    it('isWithin: containment with .., case rules, roots and spaces', () => {
        expect(isWithin('/home/andy/repo/src/a.ts', '/home/andy/repo')).toBe(true);
        expect(isWithin('/home/andy/repo', '/home/andy/repo')).toBe(true);
        expect(isWithin('/home/andy/repo/../other', '/home/andy/repo')).toBe(false);
        expect(isWithin('/home/andy/repository', '/home/andy/repo')).toBe(false);
        expect(isWithin('/home/andy/Repo/a', '/home/andy/repo')).toBe(false);
        expect(isWithin('C:\\Users\\Andy\\My Repo\\src\\a.ts', 'c:/users/andy/my repo')).toBe(true);
        expect(isWithin('D:\\Users\\andy\\repo\\a', 'C:\\Users\\andy\\repo')).toBe(false);
        expect(isWithin('\\\\server\\share\\dir\\a', '//SERVER/SHARE/dir')).toBe(true);
        expect(isWithin('\\\\server\\other\\dir\\a', '\\\\server\\share\\dir')).toBe(false);
        expect(isWithin('relative/a', '/abs')).toBe(false);
        expect(isWithin('/abs/a', 'relative')).toBe(false);
    });

    it('resolveFrom joins relative paths to the base and keeps absolute ones', () => {
        expect(resolveFrom('/home/andy/repo', 'src/../lib/a.ts')).toEqual({ root: '', segments: ['home', 'andy', 'repo', 'lib', 'a.ts'], windows: false, absolute: true });
        expect(resolveFrom('/home/andy/repo', '/etc/passwd').segments).toEqual(['etc', 'passwd']);
        expect(resolveFrom('/home/andy/repo', '../secrets').segments).toEqual(['home', 'andy', 'secrets']);
        expect(resolveFrom('/home/andy/repo', '../../../../etc').segments).toEqual(['etc']);
        expect(resolveFrom('C:\\repo', 'src\\a.ts')).toEqual({ root: 'C:', segments: ['repo', 'src', 'a.ts'], windows: true, absolute: true });
        expect(resolveFrom('C:\\repo', 'D:\\x').root).toBe('D:');
        // Rooted on the current drive inherits the base's drive.
        expect(resolveFrom('C:\\repo', '\\other')).toEqual({ root: 'C:', segments: ['other'], windows: true, absolute: true });
        // Drive-relative: on the base's drive it joins; on another drive it stays unresolved, so containment fails.
        expect(resolveFrom('C:\\repo', 'C:src')).toEqual({ root: 'C:', segments: ['repo', 'src'], windows: true, absolute: true });
        const other = resolveFrom('C:\\repo', 'D:folder');
        expect(other).toEqual({ root: 'D:', segments: ['folder'], windows: true, absolute: false });
        expect(isWithin(other, 'C:\\repo')).toBe(false);
    });
});
