// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnAgentProcess, ProcessExitedError, UnsafeArgumentError, quoteForCmd, cmdShimArgs } from '@sigx/ai-agent-node';
import { createJsonRpcPeer } from '@sigx/ai-agent/harness';
import { fixture } from './helpers';
import { collectText } from './stream-helpers';

const node = process.execPath;

function rpc(extra: Partial<Parameters<typeof spawnAgentProcess>[0]> = {}) {
    const proc = spawnAgentProcess({ command: node, args: [fixture('echo-rpc.mjs')], ...extra });
    const peer = createJsonRpcPeer({ readable: proc.readable, writable: proc.writable });
    return { proc, peer };
}

describe('spawnAgentProcess', () => {
    it('round-trips NDJSON JSON-RPC in both directions through createJsonRpcPeer', async () => {
        const { proc, peer } = rpc();
        await proc.spawned;
        expect(await peer.request('echo', { a: 1, s: 'x' })).toEqual({ a: 1, s: 'x' });
        let pinged: unknown;
        peer.onRequest('client/ping', (params) => {
            pinged = params;
            return 'pong';
        });
        expect(await peer.request('ping')).toBe('pinged');
        expect(pinged).toEqual({ from: 'fixture' });
        await peer.close();
        await proc.kill();
        expect((await proc.exited).code === 0 || (await proc.exited).signal !== null).toBe(true);
    });

    it('moves a 2 MB payload and multi-byte text intact', async () => {
        const { proc, peer } = rpc();
        const big = (await peer.request('big', { bytes: 2 * 1024 * 1024 })) as string;
        expect(big.length).toBe(2 * 1024 * 1024);
        expect(await peer.request('utf8', { times: 3 })).toBe('héllo wörld — 日本語 🚀'.repeat(3));
        await peer.close();
        await proc.kill();
    }, 30_000);

    it('a non-zero exit carries the stderr tail; ProcessExitedError formats it', async () => {
        const proc = spawnAgentProcess({ command: node, args: [fixture('stderr-exit.mjs'), '3', 'something', 'broke'], stderrTailBytes: 9 });
        const exit = await proc.exited;
        expect(exit.code).toBe(3);
        expect(exit.stderrTail).toBe('ng broke\n');
        expect(proc.stderrTail()).toBe('ng broke\n');
        const err = new ProcessExitedError('harness', exit.code, exit.signal, exit.stderrTail);
        expect(err.message).toMatch(/\[sigx ai-agent-node\] "harness" exited with code 3\nng broke/);
        expect(err.name).toBe('ProcessExitedError');
    });

    it('the child sees the allowlisted environment plus explicit additions, never NODE_OPTIONS', async () => {
        const { proc, peer } = rpc({ env: { SIGX_TEST_TOKEN: 'abc' } });
        const env = (await peer.request('env')) as Record<string, string>;
        expect(env.SIGX_TEST_TOKEN).toBe('abc');
        expect(env.NODE_OPTIONS).toBeUndefined();
        expect(Object.keys(env).some((k) => k.toLowerCase() === 'path')).toBe(true);
        await peer.close();
        await proc.kill();
    });

    it('passes arguments with quotes, ampersands, pipes, carets, percent and spaces verbatim', async () => {
        const args = ['a b', 'say "hi"', 'x&y', 'p|q', 'c^d', '%HOME%', "it's", '--flag=va lue'];
        const proc = spawnAgentProcess({ command: node, args: [fixture('args-dump.mjs'), ...args] });
        const out = await collectText(proc.readable);
        expect(JSON.parse(out.trim())).toEqual(args);
        expect((await proc.exited).code).toBe(0);
    });

    it('a spawn failure rejects `spawned` and settles `exited`', async () => {
        const proc = spawnAgentProcess({ command: 'definitely-not-a-real-binary-xyz', args: [] });
        await expect(proc.spawned).rejects.toMatchObject({ code: 'ENOENT' });
        const exit = await proc.exited;
        expect(exit.code).toBeNull();
        await proc.kill();
    });

    it('cmd.exe quoting: whole tokens quoted, inner quotes escaped, percent refused', () => {
        expect(quoteForCmd('a b')).toBe('"a b"');
        expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
        expect(quoteForCmd('x&y|z^w')).toBe('"x&y|z^w"');
        expect(() => quoteForCmd('%PATH%')).toThrow(UnsafeArgumentError);
        expect(cmdShimArgs('C:\\t\\tool.cmd', ['a b', 'c'])).toEqual(['/d', '/s', '/c', '""C:\\t\\tool.cmd" "a b" "c""']);
        expect(() => spawnAgentProcess({ command: 'C:\\t\\tool.cmd', args: ['%X%'], kind: 'cmd-shim' })).toThrow(UnsafeArgumentError);
    });

    it('closing the writable ends stdin, which ends the fixture', async () => {
        const proc = spawnAgentProcess({ command: node, args: [fixture('echo-rpc.mjs')] });
        const writer = proc.writable.getWriter();
        await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"echo","params":7}\n'));
        await writer.close();
        const out = await collectText(proc.readable);
        expect(JSON.parse(out.trim())).toEqual({ jsonrpc: '2.0', id: 1, result: 7 });
        expect((await proc.exited).code).toBe(0);
    });
});
