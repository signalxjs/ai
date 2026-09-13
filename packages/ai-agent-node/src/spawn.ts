/**
 * `spawnAgentProcess` — a harness process with Web Streams stdio.
 *
 * Never `shell: true`: a resolved `cmd-shim` is driven through `cmd.exe /d /s
 * /c` with one strictly quoted command string, and an argument that cannot be
 * quoted safely (`%`) is refused. stdout and stdin are Web Streams with real
 * backpressure so they plug into `createJsonRpcPeer`; stderr is kept in a
 * bounded tail for the error a dead process turns into. `kill()` takes the
 * whole tree down — the process group on POSIX, `taskkill /T` on Windows —
 * and children die with the parent.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { buildChildEnv } from './env.js';
import { registerChild, unregisterChild } from './exit-registry.js';
import type { ExecutableKind } from './resolve.js';

export interface SpawnAgentProcessOptions {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    /** Added to the allowlisted environment (a key, a config dir); `undefined` removes. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Copy the whole parent environment instead of the allowlist. */
    readonly inheritEnv?: boolean;
    /** Replace the default allowlist. */
    readonly allowEnv?: readonly string[];
    /** Characters of stderr kept for error reports. Default 65 536. */
    readonly stderrTailBytes?: number;
    /** Kill the child when this process exits. Default `true`. */
    readonly killOnParentExit?: boolean;
    /** From `resolveExecutable`; `cmd-shim` switches on `cmd.exe` quoting. */
    readonly kind?: ExecutableKind;
    /** Default `process.platform`. */
    readonly platform?: NodeJS.Platform;
}

export interface ProcessExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderrTail: string;
}

export interface AgentProcess {
    readonly pid: number | undefined;
    /** stdout. */
    readonly readable: ReadableStream<Uint8Array>;
    /** stdin. */
    readonly writable: WritableStream<Uint8Array>;
    stderrTail(): string;
    /** Resolves once the process is running; rejects when it could not start (ENOENT, EINVAL, …). */
    readonly spawned: Promise<void>;
    readonly exited: Promise<ProcessExit>;
    /** Terminate the whole tree; idempotent; resolves when it is gone. */
    kill(options?: { readonly graceMs?: number }): Promise<void>;
}

/** A process that ended before it should have — the stderr tail says why. */
export class ProcessExitedError extends Error {
    override readonly name = 'ProcessExitedError';
    constructor(
        readonly command: string,
        readonly code: number | null,
        readonly signal: NodeJS.Signals | null,
        readonly stderrTail: string
    ) {
        super(`[sigx ai-agent-node] "${command}" exited with ${signal ? `signal ${signal}` : `code ${code}`}${stderrTail ? `\n${stderrTail.trimEnd()}` : ''}`);
    }
}

/** An argument `cmd.exe` would rewrite (`%VAR%` expansion cannot be escaped on a `/c` line). */
export class UnsafeArgumentError extends Error {
    override readonly name = 'UnsafeArgumentError';
    constructor(readonly argument: string) {
        super(`[sigx ai-agent-node] argument ${JSON.stringify(argument)} cannot be passed through cmd.exe safely (it contains "%"); resolve the shim to its script or pass the value another way`);
    }
}

/** Quote one argument for a `cmd.exe /s /c "…"` command line: whole token in `"`, inner `"` → `\"`. */
export function quoteForCmd(arg: string): string {
    if (arg.includes('%')) throw new UnsafeArgumentError(arg);
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"`;
}

/** The single `/d /s /c "…"` argument list for a `.cmd` shim. */
export function cmdShimArgs(shim: string, args: readonly string[]): string[] {
    return ['/d', '/s', '/c', `"${[shim, ...args].map(quoteForCmd).join(' ')}"`];
}

export function spawnAgentProcess(options: SpawnAgentProcessOptions): AgentProcess {
    const platform = options.platform ?? process.platform;
    const win = platform === 'win32';
    const env = buildChildEnv({ ...(options.inheritEnv ? { inheritEnv: true } : {}), ...(options.allowEnv ? { allow: options.allowEnv } : {}), ...(options.env ? { extra: options.env } : {}), platform });
    const args = options.kind === 'cmd-shim' ? cmdShimArgs(options.command, options.args ?? []) : [...(options.args ?? [])];
    const command = options.kind === 'cmd-shim' ? (env.ComSpec ?? env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe') : options.command;
    const tailMax = options.stderrTailBytes ?? 65_536;

    const child: ChildProcess = spawn(command, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !win,
        windowsVerbatimArguments: options.kind === 'cmd-shim'
    });
    if (options.killOnParentExit !== false) registerChild(child);

    let tail = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
        tail += chunk;
        if (tail.length > tailMax) tail = tail.slice(tail.length - tailMax);
    });

    let spawnError: Error | undefined;
    const spawned = new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', (e) => {
            spawnError = e;
            reject(e);
        });
    });
    spawned.catch(() => {});

    const exited = new Promise<ProcessExit>((resolve) => {
        child.once('exit', (code, signal) => {
            unregisterChild(child);
            // stderr may still be flushing; give it a tick.
            setTimeout(() => resolve({ code, signal, stderrTail: tail }), 0);
        });
        child.once('error', () => {
            if (child.pid === undefined) resolve({ code: null, signal: null, stderrTail: spawnError ? spawnError.message : tail });
        });
    });

    // stdout → ReadableStream with backpressure through pause/resume.
    const stdout = child.stdout!;
    const readable = new ReadableStream<Uint8Array>(
        {
            start(controller) {
                stdout.on('data', (chunk: Buffer) => {
                    controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                    if ((controller.desiredSize ?? 1) <= 0) stdout.pause();
                });
                stdout.once('end', () => {
                    try {
                        controller.close();
                    } catch {
                        // Already closed by cancel().
                    }
                });
                stdout.once('error', (e) => controller.error(e));
                stdout.pause();
            },
            pull() {
                stdout.resume();
            },
            cancel() {
                stdout.destroy();
            }
        },
        { highWaterMark: 16 }
    );

    // WritableStream → stdin, awaiting drain.
    const stdin = child.stdin!;
    let stdinError: Error | undefined;
    stdin.on('error', (e) => {
        stdinError = e;
    });
    const writable = new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                if (stdinError) return reject(stdinError);
                if (stdin.destroyed || stdin.writableEnded) return reject(new Error('[sigx ai-agent-node] stdin is closed'));
                // Settle on the write callback: it reports a failure (EPIPE when the
                // child died) and, for a buffered chunk, fires once it was flushed —
                // which is the backpressure the Web Stream needs.
                stdin.write(chunk, (e) => (e ? reject(e) : resolve()));
            });
        },
        close() {
            return new Promise<void>((resolve) => stdin.end(() => resolve()));
        },
        abort() {
            stdin.destroy();
        }
    });

    let killing: Promise<void> | undefined;
    const kill = (killOptions: { readonly graceMs?: number } = {}): Promise<void> => {
        if (killing) return killing;
        killing = (async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            if (spawnError) return;
            const pid = child.pid;
            if (pid === undefined) {
                child.kill();
                await exited;
                return;
            }
            if (win) {
                await new Promise<void>((resolve) => {
                    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
                });
                await exited;
                return;
            }
            const graceMs = killOptions.graceMs ?? 2000;
            const signalTree = (signal: NodeJS.Signals) => {
                try {
                    process.kill(-pid, signal);
                } catch {
                    try {
                        child.kill(signal);
                    } catch {
                        // Gone already.
                    }
                }
            };
            signalTree('SIGTERM');
            const timer = setTimeout(() => signalTree('SIGKILL'), graceMs);
            await exited;
            clearTimeout(timer);
        })();
        return killing;
    };

    return {
        get pid() {
            return child.pid;
        },
        readable,
        writable,
        stderrTail: () => tail,
        spawned,
        exited,
        kill
    };
}
