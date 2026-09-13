// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveExecutable, parseCmdShim, ExecutableNotFoundError, spawnAgentProcess } from '@sigx/ai-agent-node';
import { collectText } from './stream-helpers';

const win = process.platform === 'win32';
let root: string;

const pnpmShim = (script: string) =>
    [
        '@SETLOCAL',
        '@IF NOT DEFINED NODE_PATH (',
        '  @SET "NODE_PATH=C:\\store\\a;C:\\store\\b"',
        ') ELSE (',
        '  @SET "NODE_PATH=C:\\store\\a;C:\\store\\b;%NODE_PATH%"',
        ')',
        '@IF EXIST "%~dp0\\node.exe" (',
        `  "%~dp0\\node.exe"  "%~dp0\\${script}" %*`,
        ') ELSE (',
        '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
        `  node  "%~dp0\\${script}" %*`,
        ')',
        ''
    ].join('\r\n');

const npmShim = (script: string) =>
    [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\' + script + '" %*',
        ''
    ].join('\r\n');

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sigx agent node '));
    await mkdir(join(root, 'bin with space'), { recursive: true });
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'tool.mjs'), "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    await writeFile(join(root, 'bin with space', 'pnpm-tool.cmd'), pnpmShim('..\\lib\\tool.mjs'));
    await writeFile(join(root, 'bin with space', 'npm-tool.cmd'), npmShim('..\\lib\\tool.mjs'));
    await writeFile(join(root, 'bin with space', 'weird.cmd'), '@echo off\r\npowershell -File "%~dp0\\x.ps1" %*\r\n');
    await writeFile(join(root, 'bin with space', 'native.exe'), 'MZ');
    await writeFile(join(root, 'bin with space', 'script.js'), 'console.log(1)');
    await writeFile(join(root, 'bin with space', 'posix-tool'), '#!/bin/sh\necho hi\n');
    if (!win) await chmod(join(root, 'bin with space', 'posix-tool'), 0o755);
});
afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('resolveExecutable', () => {
    it('finds executables on a case-insensitive Path with PATHEXT on Windows', async () => {
        const env = { Path: `C:\\nowhere;${join(root, 'bin with space')}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
        const native = await resolveExecutable('native', { env, platform: 'win32' });
        expect(native).toEqual({ path: join(root, 'bin with space', 'native.exe'), command: join(root, 'bin with space', 'native.exe'), args: [], kind: 'native' });
        const script = await resolveExecutable('script.js', { env, platform: 'win32', nodePath: 'NODE' });
        expect(script).toEqual({ path: join(root, 'bin with space', 'script.js'), command: 'NODE', args: [join(root, 'bin with space', 'script.js')], kind: 'node-script' });
    });

    it('runs a pnpm .cmd shim as a node script with its NODE_PATH', async () => {
        const env = { PATH: join(root, 'bin with space') };
        const r = await resolveExecutable('pnpm-tool', { env, platform: 'win32', nodePath: 'NODE' });
        expect(r.kind).toBe('node-script');
        expect(r.command).toBe('NODE');
        expect(r.args).toEqual([join(root, 'lib', 'tool.mjs')]);
        expect(r.env).toEqual({ NODE_PATH: 'C:\\store\\a;C:\\store\\b' });
    });

    it('runs an npm .cmd shim as a node script', async () => {
        const r = await resolveExecutable('npm-tool.cmd', { env: { PATH: join(root, 'bin with space') }, platform: 'win32', nodePath: 'NODE' });
        expect(r).toMatchObject({ kind: 'node-script', command: 'NODE', args: [join(root, 'lib', 'tool.mjs')] });
        expect(r.env).toBeUndefined();
    });

    it('falls back to cmd.exe for a shim it cannot parse', async () => {
        const r = await resolveExecutable('weird', { env: { PATH: join(root, 'bin with space'), ComSpec: 'C:\\W\\cmd.exe' }, platform: 'win32' });
        expect(r).toEqual({ path: join(root, 'bin with space', 'weird.cmd'), command: 'C:\\W\\cmd.exe', args: [join(root, 'bin with space', 'weird.cmd')], kind: 'cmd-shim' });
        expect(await parseCmdShim(join(root, 'bin with space', 'weird.cmd'))).toBeUndefined();
        expect(await parseCmdShim(join(root, 'nope.cmd'))).toBeUndefined();
    });

    it('a name with a separator is used as-is (relative to cwd), never searched', async () => {
        const r = await resolveExecutable(`bin with space${sep}script.js`, { cwd: root, env: { PATH: '/nowhere' }, platform: process.platform, nodePath: 'NODE' });
        expect(r.path).toBe(join(root, 'bin with space', 'script.js'));
        await expect(resolveExecutable('script.js', { cwd: root, env: { PATH: '/nowhere' }, platform: 'linux' })).rejects.toBeInstanceOf(ExecutableNotFoundError);
    });

    it('reports the searched directories when nothing is found', async () => {
        const err = await resolveExecutable('missing-tool', { env: { PATH: `${join(root, 'lib')}${win ? ';' : ':'}${join(root, 'bin with space')}` } }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ExecutableNotFoundError);
        expect((err as ExecutableNotFoundError).searched).toEqual([join(root, 'lib'), join(root, 'bin with space')]);
        expect((err as Error).message).toMatch(/\[sigx ai-agent-node\] executable "missing-tool" not found/);
    });

    it.skipIf(win)('POSIX requires the executable bit', async () => {
        const r = await resolveExecutable('posix-tool', { env: { PATH: join(root, 'bin with space') } });
        expect(r.kind).toBe('native');
        await chmod(join(root, 'bin with space', 'posix-tool'), 0o644);
        await expect(resolveExecutable('posix-tool', { env: { PATH: join(root, 'bin with space') } })).rejects.toBeInstanceOf(ExecutableNotFoundError);
    });

    it.skipIf(!win)('a resolved pnpm shim actually runs on Windows (through process.execPath, no shell)', async () => {
        const r = await resolveExecutable('pnpm-tool', { env: { Path: join(root, 'bin with space') } });
        const proc = spawnAgentProcess({ command: r.command, args: [...r.args, 'a b', 'c&d', '%NOPE%'], env: r.env, kind: r.kind });
        const out = await collectText(proc.readable);
        expect(JSON.parse(out.trim())).toEqual(['a b', 'c&d', '%NOPE%']);
        expect((await proc.exited).code).toBe(0);
    });
});
