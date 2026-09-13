/**
 * The client side of the protocol — what the agent may ask US: permissions,
 * session updates, and (only when the app opted in) files and terminals.
 * File and terminal requests go through the working-directory fence and the
 * session's policy before anything happens.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PolicyRequest, UnstampedEvent } from '@sigx/ai-agent';
import { codingEvent, isWithin, resolveFrom } from '@sigx/ai-agent/coding';
import { JSON_RPC, JsonRpcError, type JsonRpcPeer } from '@sigx/ai-agent/harness';
import { buildChildEnv, resolveExecutable, spawnAgentProcess, type AgentProcess } from '@sigx/ai-agent-node';
import type {
    AcpCreateTerminalRequest,
    AcpCreateTerminalResponse,
    AcpReadTextFileRequest,
    AcpReadTextFileResponse,
    AcpRequestPermissionOutcome,
    AcpRequestPermissionRequest,
    AcpRequestPermissionResponse,
    AcpSessionNotification,
    AcpSessionUpdate,
    AcpTerminalOutputResponse,
    AcpTerminalRequest,
    AcpWaitForTerminalExitResponse,
    AcpWriteTextFileRequest
} from './schema.js';
import { ACP_METHODS } from './schema.js';
import { ACP_NS } from './stream.js';

/** What the client handlers need from a session. */
export interface AcpSessionRuntime {
    readonly sessionId: string;
    readonly cwd: string;
    /** `cwd` plus the additional directories — where files may be touched. */
    readonly roots: readonly string[];
    handleUpdate(update: AcpSessionUpdate): void;
    handlePermission(request: AcpRequestPermissionRequest): Promise<AcpRequestPermissionOutcome>;
    /** Ask the session policy (through the running turn); `false` when denied or no turn runs. */
    authorize(request: PolicyRequest): Promise<{ allowed: boolean; message?: string }>;
    /** Emit into the running turn, or at session level. */
    emit(event: UnstampedEvent): void;
    readonly terminals: Map<string, TerminalState>;
}

export interface TerminalState {
    readonly process: AgentProcess;
    output: string;
    truncated: boolean;
    exit?: { exitCode: number | null; signal: string | null };
}

export interface ClientMethodOptions {
    readonly sessions: (sessionId: string) => AcpSessionRuntime | undefined;
    readonly allSessions: () => Iterable<AcpSessionRuntime>;
    readonly fs?: { readonly read?: boolean; readonly write?: boolean };
    readonly terminal?: boolean;
}

/**
 * A path the agent named, fenced to the session's roots: relative paths
 * resolve against the session `cwd` (never the process's), and the absolute
 * result is what gets used — for the check, the policy and the file system.
 */
function fence(runtime: AcpSessionRuntime, path: string): string {
    const absolute = resolve(runtime.cwd, path);
    if (!runtime.roots.some((root) => isWithin(resolveFrom(runtime.cwd, absolute), root))) {
        throw new JsonRpcError(JSON_RPC.INVALID_PARAMS, `[sigx ai-agent-acp] "${path}" is outside the session's working directory`);
    }
    return absolute;
}

/** A policy denial is an invalid request from the agent's point of view — never the auth-required code. */
async function guard(runtime: AcpSessionRuntime, request: PolicyRequest): Promise<void> {
    const { allowed, message } = await runtime.authorize(request);
    if (!allowed) throw new JsonRpcError(JSON_RPC.INVALID_REQUEST, message ?? `[sigx ai-agent-acp] ${request.toolName ?? 'the request'} was denied by policy`);
}

function withSession<P extends { sessionId: string }, R>(options: ClientMethodOptions, handler: (runtime: AcpSessionRuntime, params: P) => R | Promise<R>) {
    return (params: P) => {
        const runtime = options.sessions(params.sessionId);
        if (!runtime) throw new JsonRpcError(JSON_RPC.INVALID_PARAMS, `[sigx ai-agent-acp] unknown session "${params.sessionId}"`);
        return handler(runtime, params);
    };
}

/** Register every client-side method the adapter offers on `peer`. */
export function registerClientMethods(peer: JsonRpcPeer, options: ClientMethodOptions): void {
    peer.onRequest<AcpRequestPermissionRequest, AcpRequestPermissionResponse>(ACP_METHODS.sessionRequestPermission, async (params) => {
        const runtime = options.sessions(params.sessionId);
        if (!runtime) return { outcome: { outcome: 'cancelled' } };
        return { outcome: await runtime.handlePermission(params) };
    });

    peer.onNotification<AcpSessionNotification>(ACP_METHODS.sessionUpdate, (params) => {
        options.sessions(params.sessionId)?.handleUpdate(params.update);
    });

    if (options.fs?.read) {
        peer.onRequest<AcpReadTextFileRequest, AcpReadTextFileResponse>(
            ACP_METHODS.fsReadTextFile,
            withSession(options, async (runtime, params) => {
                const path = fence(runtime, params.path);
                await guard(runtime, { kind: 'permission', toolName: 'fs/read_text_file', input: { path }, category: 'read', source: 'client', permissionKey: 'fs/read_text_file' });
                const text = await readFile(path, 'utf8');
                if (params.line == null && params.limit == null) return { content: text };
                const lines = text.split('\n');
                const start = Math.max(0, (params.line ?? 1) - 1);
                const end = params.limit != null ? start + params.limit : lines.length;
                return { content: lines.slice(start, end).join('\n') };
            })
        );
    }

    if (options.fs?.write) {
        peer.onRequest<AcpWriteTextFileRequest, null>(
            ACP_METHODS.fsWriteTextFile,
            withSession(options, async (runtime, params) => {
                const path = fence(runtime, params.path);
                await guard(runtime, { kind: 'permission', toolName: 'fs/write_text_file', input: { path }, category: 'edit', source: 'client', permissionKey: `fs/write_text_file:${path}` });
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, params.content, 'utf8');
                return null;
            })
        );
    }

    if (options.terminal) {
        let terminalSeq = 0;
        peer.onRequest<AcpCreateTerminalRequest, AcpCreateTerminalResponse>(
            ACP_METHODS.terminalCreate,
            withSession(options, async (runtime, params) => {
                const cwd = fence(runtime, params.cwd ?? runtime.cwd);
                await guard(runtime, {
                    kind: 'permission',
                    toolName: 'terminal/create',
                    input: { command: params.command, args: params.args ?? [], cwd },
                    category: 'execute',
                    source: 'client',
                    permissionKey: `terminal/create:${params.command}`
                });
                const exe = await resolveExecutable(params.command, { cwd });
                const extra: Record<string, string> = {};
                for (const v of params.env ?? []) extra[v.name] = v.value;
                const proc = spawnAgentProcess({ command: exe.command, args: [...exe.args, ...(params.args ?? [])], cwd, env: { ...buildChildEnv({ extra: { ...exe.env, ...extra } }) }, kind: exe.kind, inheritEnv: false });
                const terminalId = `term_${++terminalSeq}`;
                const limit = params.outputByteLimit ?? 1_048_576;
                const state: TerminalState = { process: proc, output: '', truncated: false };
                runtime.terminals.set(terminalId, state);
                void (async () => {
                    const decoder = new TextDecoder();
                    try {
                        for await (const chunk of proc.readable) {
                            const delta = decoder.decode(chunk, { stream: true });
                            state.output += delta;
                            if (state.output.length > limit) {
                                state.output = state.output.slice(state.output.length - limit);
                                state.truncated = true;
                            }
                            runtime.emit(codingEvent('terminal', { terminalId, stream: 'stdout', delta }));
                        }
                    } catch {
                        // The process went away; `exited` carries the outcome.
                    }
                    const exit = await proc.exited.catch(() => ({ code: null, signal: null, stderrTail: '' }));
                    const stderr = proc.stderrTail();
                    if (stderr) {
                        state.output += stderr;
                        runtime.emit(codingEvent('terminal', { terminalId, stream: 'stderr', delta: stderr }));
                    }
                    state.exit = { exitCode: exit.code, signal: exit.signal };
                    runtime.emit(codingEvent('terminal-exit', { terminalId, exitCode: exit.code, ...(exit.signal ? { signal: exit.signal } : {}) }));
                })();
                return { terminalId };
            })
        );

        const terminal = (runtime: AcpSessionRuntime, id: string): TerminalState => {
            const t = runtime.terminals.get(id);
            if (!t) throw new JsonRpcError(JSON_RPC.INVALID_PARAMS, `[sigx ai-agent-acp] unknown terminal "${id}"`);
            return t;
        };
        peer.onRequest<AcpTerminalRequest, AcpTerminalOutputResponse>(
            ACP_METHODS.terminalOutput,
            withSession(options, (runtime, params) => {
                const t = terminal(runtime, params.terminalId);
                return { output: t.output, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) };
            })
        );
        peer.onRequest<AcpTerminalRequest, AcpWaitForTerminalExitResponse>(
            ACP_METHODS.terminalWaitForExit,
            withSession(options, async (runtime, params) => {
                const t = terminal(runtime, params.terminalId);
                const exit = await t.process.exited.catch(() => ({ code: null, signal: null }));
                return { exitCode: exit.code, signal: exit.signal };
            })
        );
        peer.onRequest<AcpTerminalRequest, null>(
            ACP_METHODS.terminalKill,
            withSession(options, async (runtime, params) => {
                await terminal(runtime, params.terminalId).process.kill().catch(() => {});
                return null;
            })
        );
        peer.onRequest<AcpTerminalRequest, null>(
            ACP_METHODS.terminalRelease,
            withSession(options, async (runtime, params) => {
                const t = terminal(runtime, params.terminalId);
                runtime.terminals.delete(params.terminalId);
                await t.process.kill().catch(() => {});
                return null;
            })
        );
    }

    // Anything else the agent tells us stays visible to the app.
    peer.onUnhandled((message) => {
        if (message.id !== undefined) return; // already answered -32601
        const event: UnstampedEvent = { type: 'ext', ns: ACP_NS, name: message.method, data: message.params ?? null };
        for (const runtime of options.allSessions()) runtime.emit(event);
    });
}
