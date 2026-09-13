// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnAgentProcess, registeredChildren, killTreeSync } from '@sigx/ai-agent-node';
import { fixture, processExists, waitFor } from './helpers';

async function firstLine(readable: ReadableStream<Uint8Array>): Promise<string> {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
            reader.releaseLock();
            return buf.slice(0, nl);
        }
    }
    reader.releaseLock();
    return buf;
}

describe('kill', () => {
    it('kill() takes the child and its grandchild down on every OS, idempotently', async () => {
        const proc = spawnAgentProcess({ command: process.execPath, args: [fixture('spawn-grandchild.mjs')] });
        const { pid, child } = JSON.parse(await firstLine(proc.readable)) as { pid: number; child: number };
        expect(pid).toBe(proc.pid);
        expect(await processExists(pid)).toBe(true);
        expect(await processExists(child)).toBe(true);
        expect(registeredChildren().some((c) => c.pid === pid)).toBe(true);
        const first = proc.kill({ graceMs: 500 });
        const second = proc.kill();
        expect(second).toBe(first);
        await first;
        expect(await waitFor(async () => !(await processExists(pid)))).toBe(true);
        expect(await waitFor(async () => !(await processExists(child)))).toBe(true);
        expect(registeredChildren().some((c) => c.pid === pid)).toBe(false);
        const exit = await proc.exited;
        expect(exit.code !== 0 || exit.signal !== null).toBe(true);
    }, 20_000);

    it('killTreeSync is the exit-path fallback and tolerates an already-dead child', async () => {
        const proc = spawnAgentProcess({ command: process.execPath, args: [fixture('spawn-grandchild.mjs')], killOnParentExit: false });
        const { pid, child } = JSON.parse(await firstLine(proc.readable)) as { pid: number; child: number };
        expect(registeredChildren().some((c) => c.pid === pid)).toBe(false);
        await proc.kill();
        expect(await waitFor(async () => !(await processExists(child)))).toBe(true);
        // A second, synchronous kill on the dead tree is a no-op.
        killTreeSync({ pid, exitCode: 1, signalCode: null } as never);
    }, 20_000);
});
