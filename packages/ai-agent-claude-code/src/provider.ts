/**
 * `claudeCode()` — Claude Code as an `Agent`, on the official Claude Agent SDK.
 *
 * One `query()` per session, kept open with a streaming prompt: every
 * `prompt()` pushes one user message and the turn ends at the SDK's
 * `result`. Permissions the CLI asks about go through the session's policy;
 * client tools are served to the CLI over MCP; the CLI process is spawned
 * through `@sigx/ai-agent-node`, so cancelling and disposing terminate the
 * whole tree on every platform. The adapter never collects, stores or
 * forwards credentials — the CLI uses whatever it is signed in with, or
 * `ANTHROPIC_API_KEY` from the environment allowlist.
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { listSessions as sdkListSessions, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { OutputFormat, Query, SDKMessage, SDKResultMessage, SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { AgentError, capabilities, createEventLog, createSessionCore, toPromptParts } from '@sigx/ai-agent';
import type { Agent, AgentCapabilities, AgentSession, PromptInput, PromptOptions, SessionRef, SessionSummary, TurnContext, TurnDriver } from '@sigx/ai-agent';
import { listenMcp, resolveExecutable, spawnAgentProcess, type AgentProcess } from '@sigx/ai-agent-node';
import type { ClaudeCodeOptions, ClaudeCodeSessionOptions } from './options.js';
import { createCanUseTool, type PermissionTarget } from './permissions.js';
import { toOutputFormat, toQueryOptions, toUserMessage } from './request.js';
import { createTurnMapper, mapSessionMessage, type TurnMapper } from './stream.js';
import { startToolServer, type ToolServer } from './tools.js';

export const DEFAULT_TOOL_SERVER = 'sigx-tools';

export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = capabilities({
    resume: 'local',
    fork: true,
    cancel: true,
    config: true,
    structuredOutput: true,
    promptParts: 'text+image',
    tools: 'mcp',
    // Mode `default` runs read-only builtins without asking: not every call reaches the policy.
    permissions: 'harness-filtered',
    listSessions: true
});

/** A push queue that is also the SDK's `AsyncIterable<SDKUserMessage>` prompt. */
function promptQueue(): { push(m: SDKUserMessage): void; end(): void } & AsyncIterable<SDKUserMessage> {
    const items: SDKUserMessage[] = [];
    let waiter: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
    let ended = false;
    return {
        push(m) {
            if (ended) return;
            if (waiter) {
                const w = waiter;
                waiter = undefined;
                w({ value: m, done: false });
            } else items.push(m);
        },
        end() {
            ended = true;
            waiter?.({ value: undefined as never, done: true });
            waiter = undefined;
        },
        [Symbol.asyncIterator]() {
            return {
                next: () =>
                    items.length
                        ? Promise.resolve({ value: items.shift()!, done: false })
                        : ended
                          ? Promise.resolve({ value: undefined as never, done: true })
                          : new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
                                waiter = resolve;
                            }),
                return: () => {
                    ended = true;
                    return Promise.resolve({ value: undefined as never, done: true });
                }
            };
        }
    };
}

/** `spawnAgentProcess` in the shape the SDK's `spawnClaudeCodeProcess` wants; `.cmd` shims are resolved first. */
export function spawnForSdk(options: SpawnOptions, resolved?: { command: string; args: readonly string[]; kind: 'native' | 'node-script' | 'cmd-shim' }): SpawnedProcess {
    const proc: AgentProcess = spawnAgentProcess({
        command: resolved?.command ?? options.command,
        args: resolved ? [...resolved.args, ...options.args] : options.args,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env,
        ...(resolved ? { kind: resolved.kind } : {})
    });
    return toSpawnedProcess(proc);
}

function toSpawnedProcess(proc: AgentProcess): SpawnedProcess {
    const emitter = new EventEmitter();
    let killed = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    void proc.exited.then(({ code, signal }) => {
        exitCode = code;
        signalCode = signal;
        emitter.emit('exit', code, signal);
    });
    proc.spawned.catch((e: unknown) => emitter.emit('error', e instanceof Error ? e : new Error(String(e))));
    return {
        stdin: Writable.fromWeb(proc.writable as unknown as import('node:stream/web').WritableStream<Uint8Array>),
        stdout: Readable.fromWeb(proc.readable as unknown as NodeReadableStream<Uint8Array>),
        get killed() {
            return killed;
        },
        get exitCode() {
            return exitCode;
        },
        get signalCode() {
            return signalCode;
        },
        pid: proc.pid,
        kill(signal: NodeJS.Signals) {
            killed = true;
            void proc.kill({ graceMs: signal === 'SIGKILL' ? 0 : 2000 }).catch(() => {});
            return true;
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
            emitter.on(event, listener);
        },
        once: (event: string, listener: (...args: unknown[]) => void) => {
            emitter.once(event, listener);
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
            emitter.off(event, listener);
        }
    } as unknown as SpawnedProcess;
}

export function claudeCode(options: ClaudeCodeOptions = {}): Agent<ClaudeCodeSessionOptions> & { listSessions(): Promise<SessionSummary[]> } {
    const id = options.id ?? 'claude-code';
    const queryFn = options.query ?? sdkQuery;
    const listSessionsFn = options.listSessions ?? sdkListSessions;
    const serverName = options.toolServerName ?? DEFAULT_TOOL_SERVER;
    const graceMs = options.interruptGraceMs ?? 2000;
    const sessions = new Set<AgentSession>();

    /** The spawner the SDK gets: ours, with a resolved override when it is a shim. */
    const spawner = async (): Promise<((o: SpawnOptions) => SpawnedProcess) | undefined> => {
        if (options.spawn) return options.spawn;
        const override = options.pathToClaudeCodeExecutable;
        if (override && /\.(cmd|bat)$/i.test(override)) {
            const resolved = await resolveExecutable(override);
            return (o) => spawnForSdk(o, resolved);
        }
        return (o) => spawnForSdk(o);
    };

    async function openSession(sessionOptions: ClaudeCodeSessionOptions): Promise<AgentSession> {
        if (!sessionOptions?.cwd) throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] session options need a cwd');
        const resume = sessionOptions.resume;
        if (resume && resume.agent !== id) throw new AgentError('protocol_error', `[sigx ai-agent-claude-code] session ref belongs to agent "${resume.agent}", not "${id}"`);
        const cwd = sessionOptions.cwd;
        const localId = resume && !sessionOptions.fork ? resume.id : `cc_${Math.random().toString(36).slice(2, 14)}`;
        let claudeSessionId: string | undefined = resume && !sessionOptions.fork ? resume.id : undefined;
        const log = createEventLog({ sessionId: localId, epoch: resume && !sessionOptions.fork ? ((resume.data as { epoch?: number } | undefined)?.epoch ?? 1) + 1 : 1 });
        const core = createSessionCore({
            id: localId,
            log,
            ...(sessionOptions.policy ? { policy: sessionOptions.policy } : {}),
            interactive: sessionOptions.interactive ?? true,
            ...(sessionOptions.requestTimeoutMs !== undefined ? { requestTimeoutMs: sessionOptions.requestTimeoutMs } : {}),
            ...(sessionOptions.signal ? { signal: sessionOptions.signal } : {})
        });

        // Client tools, served over MCP for the lifetime of the session.
        const toolServer: ToolServer | undefined = sessionOptions.tools?.length ? await startToolServer(sessionOptions.tools, { name: serverName, version: '0.1.0', listen: options.listen ?? listenMcp }) : undefined;
        const spawn = await spawner();

        // The running query and the turn it is serving.
        let q: Query | undefined;
        let queue: ReturnType<typeof promptQueue> | undefined;
        let abort: AbortController | undefined;
        let outputFormat: OutputFormat | undefined;
        let reader: Promise<void> | undefined;
        let stderrTail = '';
        let interrupted = false;
        let lastCost = 0;
        let current: { driver: TurnDriver; ctx: TurnContext; mapper: TurnMapper; done: (r: SDKResultMessage | undefined, error?: Error) => void } | undefined;
        // The first query resumes (or forks) the ref's session; later ones resume the live id.
        let firstQuery = true;

        const canUseTool = createCanUseTool(
            (): PermissionTarget | undefined => (current ? { ctx: current.ctx, callIdFor: (n, i) => current!.mapper.callIdFor(n, i), markDenied: (n, i, c) => current?.mapper.markDenied(n, i, c) } : undefined),
            serverName
        );

        const emitSession = (m: SDKMessage) => {
            if (m.type === 'system' && (m as { subtype: string }).subtype === 'init') claudeSessionId = (m as { session_id: string }).session_id;
            if (current) current.mapper.handle(m);
            else mapSessionMessage(m, (e) => core.emit(e));
        };

        const startQuery = (format: OutputFormat | undefined) => {
            queue = promptQueue();
            abort = new AbortController();
            outputFormat = format;
            interrupted = false;
            const resumeId = claudeSessionId ?? (firstQuery ? resume?.id : undefined);
            const forkNow = firstQuery && !!resume && !!sessionOptions.fork;
            const opts = toQueryOptions({
                agent: options,
                session: sessionOptions,
                ...(resumeId !== undefined ? { resumeId } : {}),
                ...(forkNow ? { fork: true } : {}),
                ...(format ? { outputFormat: format } : {}),
                ...(toolServer ? { mcpServers: { [toolServer.name]: toolServer.config } } : {}),
                canUseTool,
                abortController: abort,
                stderr: (data) => {
                    stderrTail = (stderrTail + data).slice(-8192);
                },
                ...(spawn ? { spawn } : {}),
                ...(options.pathToClaudeCodeExecutable !== undefined && !/\.(cmd|bat)$/i.test(options.pathToClaudeCodeExecutable) ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {})
            });
            firstQuery = false;
            const started = queryFn({ prompt: queue, options: opts });
            q = started;
            reader = (async () => {
                let failure: Error | undefined;
                try {
                    for await (const m of started) emitSession(m);
                } catch (e) {
                    failure = e instanceof Error ? e : new Error(String(e));
                } finally {
                    if (q === started) {
                        q = undefined;
                        queue = undefined;
                    }
                    // The process is gone: a turn still waiting for its result ends here.
                    current?.done(undefined, failure);
                }
            })();
        };

        const stopQuery = async () => {
            const running = q;
            q = undefined;
            queue?.end();
            queue = undefined;
            if (running) {
                try {
                    running.close();
                } catch {
                    // already closed
                }
            }
            abort?.abort();
            await reader?.catch(() => {});
        };

        const session: AgentSession & { configure(patch: Readonly<Record<string, string>>): Promise<void> } = {
            id: localId,
            get ref(): SessionRef {
                return { agent: id, v: 1, id: claudeSessionId ?? localId, data: { cwd, epoch: log.epoch } };
            },
            prompt(input: PromptInput, promptOptions?: PromptOptions) {
                return core.startTurn(input, promptOptions, async (driver, ctx) => {
                    const parts = toPromptParts(input);
                    driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                    const format = toOutputFormat(promptOptions?.output);
                    // `outputFormat` is per query: a different schema means a fresh query on the same session.
                    if (q && JSON.stringify(format ?? null) !== JSON.stringify(outputFormat ?? null)) await stopQuery();
                    if (!q) startQuery(format);
                    const mapper = createTurnMapper({
                        driver,
                        serverName,
                        onResult: (r) => current?.done(r),
                        interrupted: () => interrupted,
                        previousCostUsd: () => lastCost
                    });
                    const finished = new Promise<void>((resolve) => {
                        current = {
                            driver,
                            ctx,
                            mapper,
                            done: (result, failure) => {
                                current = undefined;
                                if (result && typeof result.total_cost_usd === 'number') lastCost = result.total_cost_usd;
                                if (!result && !driver.ended) {
                                    const message = failure ? failure.message : `Claude Code exited before the turn ended${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
                                    if (!driver.signal.aborted) driver.emit({ type: 'error', code: 'process_exited', message, recoverable: false });
                                    driver.end({ stopReason: driver.signal.aborted ? 'cancelled' : 'error', ...(driver.signal.aborted ? {} : { error: { code: 'process_exited', message } }) });
                                }
                                resolve();
                            }
                        };
                    });
                    const onAbort = () => {
                        interrupted = true;
                        const running = q;
                        void running?.interrupt().catch(() => {});
                        setTimeout(() => {
                            if (current?.driver === driver) abort?.abort();
                        }, graceMs);
                    };
                    driver.signal.addEventListener('abort', onAbort, { once: true });
                    try {
                        queue!.push(toUserMessage(parts));
                        await finished;
                    } finally {
                        driver.signal.removeEventListener('abort', onAbort);
                    }
                });
            },
            respond: (requestId, decision) => core.respond(requestId, decision),
            cancel: () => core.cancel(),
            async configure(patch) {
                if (!q) throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] configure() needs a running session (prompt first)');
                if (patch.model !== undefined) await q.setModel(patch.model);
                if (patch.permissionMode !== undefined) {
                    if (patch.permissionMode === 'bypassPermissions' && !options.allowDangerouslySkipPermissions) throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] bypassPermissions needs allowDangerouslySkipPermissions');
                    await q.setPermissionMode(patch.permissionMode as never);
                }
                core.emit({
                    type: 'config',
                    options: [
                        ...(patch.model !== undefined ? [{ id: 'model', label: 'Model', values: [{ id: patch.model }], current: patch.model }] : []),
                        ...(patch.permissionMode !== undefined ? [{ id: 'permissionMode', label: 'Permission mode', values: ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'].map((v) => ({ id: v })), current: patch.permissionMode }] : [])
                    ]
                });
            },
            subscribe: (from) => core.subscribe(from),
            async close() {
                await core.close();
                await stopQuery();
                await toolServer?.close();
                sessions.delete(session);
            }
        };
        sessions.add(session);
        return session;
    }

    return {
        id,
        capabilities: CLAUDE_CODE_CAPABILITIES,
        session: (sessionOptions) => openSession(sessionOptions as ClaudeCodeSessionOptions),
        async listSessions() {
            const list = await listSessionsFn();
            return list.map((s) => ({
                ref: { agent: id, v: 1, id: s.sessionId, data: { cwd: (s as { cwd?: string }).cwd } },
                title: s.summary,
                updatedAt: s.lastModified
            }));
        },
        async dispose() {
            await Promise.all([...sessions].map((s) => s.close()));
        }
    };
}
