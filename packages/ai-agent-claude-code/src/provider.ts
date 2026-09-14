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
import type { Agent, AgentCapabilities, AgentSession, CancelTarget, PromptInput, PromptOptions, SessionRef, SessionSummary, TurnContext, TurnDriver } from '@sigx/ai-agent';
import { listenMcp, resolveExecutable, spawnAgentProcess, type AgentProcess } from '@sigx/ai-agent-node';
import type { ClaudeCodeOptions, ClaudeCodeSessionOptions } from './options.js';
import { createCanUseTool, type PermissionTarget } from './permissions.js';
import { THINKING_DISPLAYS, configOptions, createConfigState, thinkingBudgetOf, thinkingDisplayOf, toOutputFormat, toQueryOptions, toUserMessage, type ThinkingDisplay } from './request.js';
import { createTurnMapper, mapSessionMessage, type TurnMapper } from './stream.js';
import { createAgentTracker } from './tasks.js';
import { startToolServer, type ToolServer } from './tools.js';

export const DEFAULT_TOOL_SERVER = 'sigx-tools';

export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = capabilities({
    resume: 'local',
    fork: true,
    cancel: true,
    // `steer` stays OFF. A second user message reaches the CLI mid-turn, but
    // the CLI decides whether it folds into the running turn between tool
    // rounds or starts a new turn after the result — same-turn injection is
    // not a promise the adapter can keep (see the live probe in the tests).
    steer: false,
    config: true,
    structuredOutput: true,
    promptParts: 'text+image',
    tools: 'mcp',
    // Mode `default` runs read-only builtins without asking: not every call reaches the policy.
    permissions: 'harness-filtered',
    listSessions: true,
    // Task frames are `agent-start` / `agent-update`; `cancel({ agentId })` is `stopTask`;
    // a sub-agent's permission questions come through the same `canUseTool` and `respond()`.
    subagents: 'control',
    // `session({ agents })` becomes the SDK's programmatic `agents`.
    defineAgents: true
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
            subagents: 'control',
            promptParts: CLAUDE_CODE_CAPABILITIES.promptParts,
            ...(sessionOptions.policy ? { policy: sessionOptions.policy } : {}),
            interactive: sessionOptions.interactive ?? true,
            ...(sessionOptions.requestTimeoutMs !== undefined ? { requestTimeoutMs: sessionOptions.requestTimeoutMs } : {}),
            ...(sessionOptions.signal ? { signal: sessionOptions.signal } : {})
        });
        // The session's sub-agents: a background one outlives the turn that spawned it.
        const tracker = createAgentTracker();
        const emitSessionEvent = (e: Parameters<typeof core.emit>[0]) => {
            core.emit(e);
        };

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
        // Everything this session advertises, in one place: `system/init`
        // fills in the model and the mode, `configure()` moves whichever it
        // was given, and both emit the WHOLE list (#137). The thinking
        // display is ours alone — `init` never mentions it — and stays absent
        // when we cannot know it (thinking disabled, or inherited from the
        // CLI's own settings), which is what makes it unconfigurable below.
        const config = createConfigState(
            (() => {
                const display = thinkingDisplayOf(sessionOptions.thinking);
                return display !== undefined ? { thinkingDisplay: display } : {};
            })(),
            options.models
        );
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
            else if (!tracker.handleTask(m, emitSessionEvent)) mapSessionMessage(m, emitSessionEvent, config);
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
            // The process is gone, and every background agent with it.
            if (!core.closed) tracker.sweep('cancelled', emitSessionEvent);
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
                        tracker,
                        onResult: (r) => current?.done(r),
                        interrupted: () => interrupted,
                        previousCostUsd: () => lastCost,
                        config
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
                                    // Every sub-agent, background ones included, died with the process.
                                    tracker.sweep(driver.signal.aborted ? 'cancelled' : 'failed', (e) => driver.emit(e), { message });
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
            async cancel(target?: CancelTarget) {
                if (target?.agentId === undefined || target.agentId === localId) return core.cancel();
                // A sub-agent that is already over is a no-op, like a late respond().
                if (tracker.get(target.agentId)?.terminal) return;
                const running = q;
                if (!running) throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] cancel({ agentId }) needs a running session (prompt first)');
                try {
                    await running.stopTask(target.agentId);
                } catch (e) {
                    throw new AgentError('protocol_error', `[sigx ai-agent-claude-code] Claude Code could not stop task "${target.agentId}": ${e instanceof Error ? e.message : String(e)}`);
                }
            },
            async configure(patch) {
                if (!q) throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] configure() needs a running session (prompt first)');
                // Applied one by one, so a patch that fails half way leaves the
                // advertised state matching what the CLI actually took.
                if (patch.model !== undefined) {
                    await q.setModel(patch.model);
                    config.update({ model: patch.model });
                }
                if (patch.permissionMode !== undefined) {
                    if (patch.permissionMode === 'bypassPermissions' && !options.allowDangerouslySkipPermissions) throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] bypassPermissions needs allowDangerouslySkipPermissions');
                    await q.setPermissionMode(patch.permissionMode as never);
                    config.update({ permissionMode: patch.permissionMode });
                }
                if (patch.thinkingDisplay !== undefined) {
                    const next = patch.thinkingDisplay as ThinkingDisplay;
                    if (!THINKING_DISPLAYS.includes(next)) throw new AgentError('protocol_error', `[sigx ai-agent-claude-code] thinkingDisplay must be one of ${THINKING_DISPLAYS.join(', ')}, not "${patch.thinkingDisplay}"`);
                    // Only a session that ADVERTISES the option can be switched:
                    // one started with `thinking: null` deferred the display to
                    // Claude Code's own settings, and one with
                    // `{ type: 'disabled' }` has no thinking to display —
                    // changing either would answer a question nobody could ask.
                    if (config.current().thinkingDisplay === undefined) {
                        throw new AgentError('protocol_error', '[sigx ai-agent-claude-code] this session does not advertise thinkingDisplay — it was opened with thinking disabled, or with `thinking: null` to inherit Claude Code\'s own setting');
                    }
                    // The display is the only thing that changes: the budget
                    // argument carries the session's own thinking mode back in.
                    await q.setMaxThinkingTokens(thinkingBudgetOf(sessionOptions.thinking), next);
                    config.update({ thinkingDisplay: next });
                }
                // The WHOLE list, not just what moved: a `config` event is the
                // options, and the reducer replaces the list with it (#137).
                core.emit({ type: 'config', options: config.options() });
            },
            subscribe: (from) => core.subscribe(from),
            async close() {
                // A background agent ends with the session; a foreground one ends with its turn (below).
                tracker.sweep('cancelled', emitSessionEvent);
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
