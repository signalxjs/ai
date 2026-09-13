/**
 * One ACP session as an `AgentSession`: `session/new` (or resume / load /
 * fork), `session/prompt` per turn with the updates mapped into the turn,
 * permissions through the policy, `session/cancel`, modes and config.
 */

import type { AnyTool } from '@sigx/ai';
import { AgentError, createEventLog, createSessionCore, toPromptParts } from '@sigx/ai-agent';
import type { AgentSession, PolicyRequest, PromptInput, PromptOptions, SessionRef, ToolStatus, TurnContext, TurnDriver, UnstampedEvent } from '@sigx/ai-agent';
import { createMcpToolHandler, JsonRpcError, type JsonRpcPeer } from '@sigx/ai-agent/harness';
import { listenMcp, type McpListener } from '@sigx/ai-agent-node';
import type { AcpSessionRuntime, TerminalState } from './client-methods.js';
import type { AcpOptions, AcpSessionOptions } from './options.js';
import type {
    AcpForkSessionResponse,
    AcpInitializeResponse,
    AcpMcpServer,
    AcpNewSessionResponse,
    AcpPromptResponse,
    AcpRequestPermissionOutcome,
    AcpRequestPermissionRequest,
    AcpResumeSessionResponse,
    AcpSessionConfigOption,
    AcpSessionModeState,
    AcpSessionUpdate
} from './schema.js';
import { ACP_AUTH_REQUIRED, ACP_METHODS } from './schema.js';
import { ACP_NS, createUpdateMapper, toConfigOptions, toPermissionOutcome, toPromptPart, toStopReason, toUsage, toAcpBlocks } from './stream.js';

/** What the ref carries: enough to `session/load` the same id in the same place. */
export interface AcpRefData {
    readonly cwd: string;
    readonly additionalDirectories?: readonly string[];
    readonly epoch: number;
}

export interface OpenAcpSessionOptions {
    readonly peer: JsonRpcPeer;
    readonly agentId: string;
    readonly init: AcpInitializeResponse;
    readonly options: AcpOptions;
    readonly sessionOptions: AcpSessionOptions;
    readonly runtimes: Map<string, AcpSessionRuntime>;
}

interface Current {
    readonly driver: TurnDriver;
    readonly ctx: TurnContext;
    readonly mapper: ReturnType<typeof createUpdateMapper>;
    readonly calls: Map<string, ToolStatus>;
}

const TERMINAL: ReadonlySet<ToolStatus> = new Set(['completed', 'failed', 'cancelled', 'denied']);

export async function openAcpSession(o: OpenAcpSessionOptions): Promise<AgentSession> {
    const { peer, agentId, init, sessionOptions, runtimes } = o;
    const caps = init.agentCapabilities ?? {};
    const resume = sessionOptions.resume;
    const refData = (resume?.data ?? {}) as Partial<AcpRefData>;
    // A resumed session continues in the same place unless the caller says otherwise.
    const cwd = sessionOptions.cwd ?? refData.cwd;
    if (!cwd) throw new AgentError('protocol_error', `[sigx ai-agent-acp] a session needs a cwd (none given and none in the ref)`);
    const additionalDirectories = sessionOptions.additionalDirectories ? [...sessionOptions.additionalDirectories] : refData.additionalDirectories ? [...refData.additionalDirectories] : undefined;
    const roots = [cwd, ...(additionalDirectories ?? [])];
    const tools: readonly AnyTool[] = sessionOptions.tools ?? [];

    // Client tools ride along as an HTTP MCP server — only if the agent can take one.
    let listener: McpListener | undefined;
    const mcpServers: AcpMcpServer[] = [...(sessionOptions.mcpServers ?? [])];
    if (tools.length) {
        if (!caps.mcpCapabilities?.http) {
            throw new AgentError('protocol_error', `[sigx ai-agent-acp] agent "${agentId}" does not accept HTTP MCP servers; client tools cannot be provided`);
        }
        listener = await listenMcp(createMcpToolHandler(tools, { name: 'sigx-tools', version: '0.1.0' }));
        mcpServers.push({ type: 'http', name: 'sigx-tools', url: listener.url, headers: [{ name: 'Authorization', value: listener.headers.Authorization }] });
    }

    let sessionId: string;
    let epoch = 1;
    let modes: AcpSessionModeState | null | undefined;
    let configOptions: AcpSessionConfigOption[] | null | undefined;
    let pendingLoad: (() => Promise<void>) | undefined;

    const authError = (e: unknown, what: string): never => {
        if (e instanceof JsonRpcError && e.code === ACP_AUTH_REQUIRED) {
            throw new AgentError('auth_required', `[sigx ai-agent-acp] agent "${agentId}" requires authentication before ${what}`, false, { cause: e, data: init.authMethods ?? [] });
        }
        throw e;
    };

    try {
        if (resume) {
            if (resume.agent !== agentId) throw new AgentError('protocol_error', `[sigx ai-agent-acp] session ref belongs to agent "${resume.agent}", not "${agentId}"`);
            const data = refData;
            const base = { cwd, ...(additionalDirectories ? { additionalDirectories } : {}) };
            if (sessionOptions.fork) {
                if (!caps.sessionCapabilities?.fork) throw new AgentError('protocol_error', `[sigx ai-agent-acp] agent "${agentId}" cannot fork sessions`);
                const res = await peer.request<AcpForkSessionResponse>(ACP_METHODS.sessionFork, { sessionId: resume.id, ...base, mcpServers });
                sessionId = res.sessionId;
                modes = res.modes;
                configOptions = res.configOptions;
            } else if (caps.sessionCapabilities?.resume) {
                sessionId = resume.id;
                epoch = (data.epoch ?? 0) + 1;
                const res = await peer.request<AcpResumeSessionResponse>(ACP_METHODS.sessionResume, { sessionId, ...base, mcpServers });
                modes = res.modes;
                configOptions = res.configOptions;
            } else if (caps.loadSession) {
                sessionId = resume.id;
                epoch = (data.epoch ?? 0) + 1;
                // `session/load` replays the history as updates while the request is
                // in flight: the runtime must exist first, so the load runs after it.
                pendingLoad = async () => {
                    const res = await peer.request<AcpResumeSessionResponse>(ACP_METHODS.sessionLoad, { sessionId, ...base, mcpServers });
                    modes = res.modes;
                    configOptions = res.configOptions;
                };
            } else {
                throw new AgentError('protocol_error', `[sigx ai-agent-acp] agent "${agentId}" cannot resume sessions`);
            }
        } else {
            const res = await peer.request<AcpNewSessionResponse>(ACP_METHODS.sessionNew, { cwd, ...(additionalDirectories ? { additionalDirectories } : {}), mcpServers });
            sessionId = res.sessionId;
            modes = res.modes;
            configOptions = res.configOptions;
        }
    } catch (e) {
        await listener?.close().catch(() => {});
        authError(e, 'opening a session');
    }

    const log = createEventLog({ sessionId: sessionId!, epoch });
    const core = createSessionCore({
        id: sessionId!,
        log,
        ...(sessionOptions.policy ? { policy: sessionOptions.policy } : {}),
        interactive: sessionOptions.interactive ?? true,
        ...(sessionOptions.requestTimeoutMs !== undefined ? { requestTimeoutMs: sessionOptions.requestTimeoutMs } : {}),
        ...(sessionOptions.signal ? { signal: sessionOptions.signal } : {})
    });
    let current: Current | undefined;
    let closed = false;

    const emit = (event: UnstampedEvent): void => {
        if (closed) return;
        if (current && !current.driver.ended) current.driver.emit(event);
        else core.emit(event);
    };
    const emitConfig = () => {
        const options = toConfigOptions(modes, configOptions);
        if (options.length) emit({ type: 'config', options });
    };

    // History replayed by `session/load` (or updates between turns) lands at session level.
    let history: ReturnType<typeof createUpdateMapper> | undefined;
    let pendingUser: { id: string; parts: NonNullable<ReturnType<typeof toPromptPart>>[] } | undefined;
    let historySeq = 0;
    const flushUser = () => {
        if (pendingUser) emit({ type: 'user-message', messageId: pendingUser.id, parts: pendingUser.parts });
        pendingUser = undefined;
    };
    const historyDriver: TurnDriver = {
        turnId: `history:${epoch}`,
        signal: core.signal,
        get ended() {
            return false;
        },
        emit: (e) => core.emit(e),
        end: () => {}
    };

    const runtime: AcpSessionRuntime = {
        sessionId: sessionId!,
        cwd,
        roots,
        terminals: new Map<string, TerminalState>(),
        emit,
        handleUpdate(update: AcpSessionUpdate) {
            if (closed) return;
            switch (update.sessionUpdate) {
                case 'current_mode_update':
                    if (modes) modes = { ...modes, currentModeId: update.currentModeId };
                    else modes = { currentModeId: update.currentModeId, availableModes: [{ id: update.currentModeId, name: update.currentModeId }] };
                    emitConfig();
                    return;
                case 'config_option_update':
                    configOptions = update.configOptions;
                    emitConfig();
                    return;
                case 'session_info_update':
                case 'available_commands_update':
                    emit({ type: 'ext', ns: ACP_NS, name: update.sessionUpdate, data: update });
                    return;
            }
            if (current && !current.driver.ended) {
                current.mapper.apply(update);
                return;
            }
            // Outside a turn: history.
            if (update.sessionUpdate === 'user_message_chunk') {
                const part = toPromptPart(update.content);
                const id = update.messageId ? `u:${update.messageId}` : (pendingUser?.id ?? `u:history:${epoch}:${historySeq++}`);
                if (pendingUser && pendingUser.id !== id) flushUser();
                pendingUser ??= { id, parts: [] };
                if (part) pendingUser.parts.push(part);
                return;
            }
            flushUser();
            history ??= createUpdateMapper(historyDriver, { turnId: historyDriver.turnId });
            history.apply(update);
        },
        async handlePermission(request: AcpRequestPermissionRequest): Promise<AcpRequestPermissionOutcome> {
            if (!current || current.driver.ended) return { outcome: 'cancelled' };
            const call = request.toolCall;
            const toolName = call.name ?? call.title ?? call.toolCallId;
            const location = call.locations?.[0]?.path;
            const resolved = await current.ctx.resolve({
                kind: 'permission',
                callId: call.toolCallId,
                toolName,
                ...(call.rawInput !== undefined ? { input: call.rawInput } : {}),
                ...(call.kind ? { category: call.kind === 'switch_mode' ? 'other' : call.kind } : {}),
                source: 'native',
                ...(call.title ? { message: call.title } : {}),
                options: request.options.map((opt) => ({ id: opt.optionId, label: opt.name, description: opt.kind })),
                permissionKey: location ? `${toolName}:${location}` : toolName
            });
            return toPermissionOutcome(resolved.decision, request.options);
        },
        async authorize(request: PolicyRequest) {
            if (!current || current.driver.ended) return { allowed: false, message: `[sigx ai-agent-acp] ${request.toolName ?? 'request'} outside a turn` };
            const resolved = await current.ctx.resolve(request);
            const d = resolved.decision;
            if (d.type === 'permission' && d.outcome === 'allow') return { allowed: true };
            return { allowed: false, ...(d.type === 'permission' && d.message ? { message: d.message } : {}) };
        }
    };
    runtimes.set(sessionId!, runtime);

    if (pendingLoad) {
        try {
            await pendingLoad();
        } catch (e) {
            runtimes.delete(sessionId!);
            await listener?.close().catch(() => {});
            authError(e, 'loading the session');
        }
        flushUser();
        history?.finish();
    }
    emitConfig();

    const ref = (): SessionRef => ({ agent: agentId, v: 1, id: sessionId!, data: { cwd, ...(additionalDirectories ? { additionalDirectories } : {}), epoch: log.epoch } satisfies AcpRefData });

    const session: AgentSession = {
        id: sessionId!,
        get ref() {
            return ref();
        },
        prompt(input: PromptInput, promptOptions?: PromptOptions) {
            return core.startTurn(input, promptOptions, async (driver, ctx) => {
                const parts = toPromptParts(input);
                driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                const calls = new Map<string, ToolStatus>();
                const tracking: TurnDriver = {
                    ...driver,
                    get ended() {
                        return driver.ended;
                    },
                    emit(e) {
                        if (e.type === 'tool-call' && !calls.has(e.callId)) calls.set(e.callId, 'pending');
                        if (e.type === 'tool-update') calls.set(e.callId, e.status);
                        return driver.emit(e);
                    }
                };
                const mapper = createUpdateMapper(tracking, { turnId: driver.turnId });
                current = { driver, ctx, mapper, calls };
                let cancelSent = false;
                const sendCancel = () => {
                    if (cancelSent) return;
                    cancelSent = true;
                    void peer.notify(ACP_METHODS.sessionCancel, { sessionId }).catch(() => {});
                };
                if (driver.signal.aborted) sendCancel();
                else driver.signal.addEventListener('abort', sendCancel, { once: true });
                const settleCalls = () => {
                    for (const [callId, status] of calls) {
                        if (!TERMINAL.has(status)) driver.emit({ type: 'tool-update', callId, status: driver.signal.aborted || cancelSent ? 'cancelled' : 'failed' });
                    }
                };
                try {
                    const res = await peer.request<AcpPromptResponse>(ACP_METHODS.sessionPrompt, { sessionId, prompt: toAcpBlocks(parts) });
                    mapper.finish();
                    settleCalls();
                    const usage = res.usage ? toUsage(res.usage) : undefined;
                    if (usage) driver.emit({ type: 'usage', scope: 'turn', usage });
                    driver.end({ stopReason: toStopReason(res.stopReason), ...(usage ? { usage } : {}) });
                } catch (e) {
                    mapper.finish();
                    settleCalls();
                    if (e instanceof JsonRpcError) {
                        if (e.code === -32800 || driver.signal.aborted) {
                            driver.end({ stopReason: 'cancelled' });
                            return;
                        }
                        const code = e.code === ACP_AUTH_REQUIRED ? 'auth_required' : 'provider_error';
                        driver.emit({ type: 'error', code, message: e.message, recoverable: code === 'auth_required', ...(e.data !== undefined ? { data: e.data } : {}) });
                        driver.end({ stopReason: 'error', error: { code, message: e.message } });
                        return;
                    }
                    throw e;
                } finally {
                    driver.signal.removeEventListener('abort', sendCancel);
                    current = undefined;
                }
            });
        },
        respond: (requestId, decision) => core.respond(requestId, decision),
        cancel: () => core.cancel(),
        async configure(patch: Readonly<Record<string, string>>) {
            for (const [key, value] of Object.entries(patch)) {
                if (key === 'mode') {
                    await peer.request(ACP_METHODS.sessionSetMode, { sessionId, modeId: value });
                    if (modes) modes = { ...modes, currentModeId: value };
                    continue;
                }
                const option = configOptions?.find((c) => c.id === key);
                if (!option) throw new AgentError('protocol_error', `[sigx ai-agent-acp] unknown config option "${key}"`);
                if (option.type === 'boolean') await peer.request(ACP_METHODS.sessionSetConfigOption, { sessionId, configId: key, type: 'boolean', value: value === 'true' });
                else await peer.request(ACP_METHODS.sessionSetConfigOption, { sessionId, configId: key, value });
                configOptions = configOptions!.map((c): AcpSessionConfigOption => {
                    if (c.id !== key) return c;
                    return c.type === 'boolean' ? { ...c, currentValue: value === 'true' } : { ...c, currentValue: value };
                });
            }
            emitConfig();
        },
        subscribe: (from) => core.subscribe(from),
        async close() {
            if (closed) return;
            if (caps.sessionCapabilities?.close) await peer.request(ACP_METHODS.sessionClose, { sessionId }).catch(() => {});
            await core.close();
            closed = true;
            runtimes.delete(sessionId!);
            for (const t of runtime.terminals.values()) await t.process.kill().catch(() => {});
            runtime.terminals.clear();
            await listener?.close().catch(() => {});
        }
    };
    return session;
}

/** The peer went away under a live session: fail the running turn and record the error. */
export function failSession(runtime: AcpSessionRuntime, message: string): void {
    runtime.emit({ type: 'error', code: 'process_exited', message, recoverable: false });
}
