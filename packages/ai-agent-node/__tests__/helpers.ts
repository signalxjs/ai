/** Shared helpers for the Node package tests: fixture paths and process probes. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export const fixtures = join(import.meta.dirname, 'fixtures');
export const fixture = (name: string) => join(fixtures, name);

/** Whether a process with `pid` still exists. */
export async function processExists(pid: number): Promise<boolean> {
    if (process.platform === 'win32') {
        return new Promise((resolve) => {
            execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (_e, stdout) => resolve(stdout.includes(`"${pid}"`)));
        });
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000, everyMs = 50): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, everyMs));
    }
    return check();
}

export function tick(ms = 0): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
