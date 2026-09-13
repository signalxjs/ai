/**
 * Children die with the parent. One `exit` handler, registered on first use,
 * kills every still-running child synchronously (the event loop is gone by
 * then, so nothing async would run). Signal forwarding is opt-in: a host may
 * have its own shutdown sequence.
 */

import { spawnSync, type ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();
let installed = false;
let signalsInstalled = false;

/** Kill the whole tree of `child` without waiting — for the `exit` path. */
export function killTreeSync(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
        if (platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                child.kill('SIGKILL');
            }
        }
    } catch {
        // Already gone.
    }
}

export function registerChild(child: ChildProcess): void {
    children.add(child);
    child.once('exit', () => children.delete(child));
    if (!installed) {
        installed = true;
        process.once('exit', () => {
            for (const c of children) killTreeSync(c);
            children.clear();
        });
    }
}

export function unregisterChild(child: ChildProcess): void {
    children.delete(child);
}

/** Children currently registered (tests, diagnostics). */
export function registeredChildren(): readonly ChildProcess[] {
    return [...children];
}

/**
 * Forward `SIGINT` / `SIGTERM` to the registered children and then re-raise
 * the default behaviour (exit). Opt-in; call once.
 */
export function installSignalForwarding(signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): () => void {
    if (signalsInstalled) return () => {};
    signalsInstalled = true;
    const handlers = signals.map((signal) => {
        const handler = () => {
            for (const c of children) killTreeSync(c);
            children.clear();
            process.exit(signal === 'SIGINT' ? 130 : 143);
        };
        process.on(signal, handler);
        return [signal, handler] as const;
    });
    return () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
        signalsInstalled = false;
    };
}
