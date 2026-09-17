/**
 * A Codex thread as an `AgentSession`. Each `prompt()` is one `turn/start`
 * whose notifications flow through the turn mapper into the session log;
 * Codex's requests (approvals, questions, dynamic tool calls) are answered
 * through the session's policy while the turn runs.
 */

import { validateWith, type AnyTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import type { AgentSession, ConfigOption, PromptInput, PromptOptions, PromptPart, SessionRef, TurnDriver, TurnContext, UnstampedEvent } from '@sigx/ai-agent';
import { AgentError, createEventLog, createSessionCore } from '@sigx/ai-agent';
import type { JsonRpcPeer, RequestContext } from '@sigx/ai-agent/harness';
import { approveCommand, approveFileChange, approvePermissions, askUserInput } from './approvals.js';
import type { CodexCliSessionOptions } from './options.js';
import { CODEX_METHODS } from './schema.js';
import type {
    AskForApproval,
    CommandExecutionRequestApprovalParams,
    DynamicToolCallParams,
    FileChangeRequestApprovalParams,
    PermissionsRequestApprovalParams,
    SandboxMode,
    SandboxPolicy,
    SandboxPolicyParam,
    Thread,
    ThreadStartResponse,
    ThreadTokenUsageUpdatedNotification,
    ToolRequestUserInputParams,
    TurnCompletedNotification,
    TurnStartParams,
    TurnStartResponse,
    TurnSteerParams,
    TurnSteerResponse,
    UserInput
} from './schema.js';
import { AGENT_TERMINAL, CODEX_CLI_NS, createTurnMapper, settleSubAgents, toUsage, updateSubAgent, type SubAgents, type TurnMapper } from './stream.js';
import { callDynamicTool } from './tools.js';

export interface CodexSessionDeps {
    readonly agentId: string;
    readonly peer: JsonRpcPeer;
    /** `turn/interrupt` for a running Codex turn. */
    readonly interrupt: (threadId: string, codexTurnId: string) => Promise<void>;
    readonly thread: ThreadStartResponse;
    readonly cwd: string;
    readonly tools: readonly AnyTool[];
    readonly options: CodexCliSessionOptions;
    readonly models: readonly { readonly id: string; readonly label?: string }[];
    readonly epoch: number;
    /** Called when the session closes so the agent forgets it. */
    readonly onClose: (threadId: string) => void;
    /** A sub-agent thread of this session was seen: route that thread's frames (and any already held) here. */
    readonly adoptChild: (childThreadId: string) => void;
}

type NotificationParams = { readonly threadId?: string; readonly turnId?: string } & Record<string, unknown>;

/** The session plus the hooks the agent's dispatcher calls. */
export interface CodexSession extends AgentSession {
    readonly threadId: string;
    handleNotification(method: string, params: NotificationParams): void;
    handleRequest(method: string, params: unknown, ctx: RequestContext): Promise<unknown>;
    /** Whether `threadId` is one of this session's sub-agent threads. */
    ownsThread(threadId: string): boolean;
    /** A frame from one of this session's sub-agent threads. */
    handleChildNotification(childThreadId: string, method: string, params: NotificationParams): void;
    /** A request raised on one of this session's sub-agent threads, answered through the host policy. */
    handleChildRequest(childThreadId: string, method: string, params: unknown, ctx: RequestContext): Promise<unknown>;
    /** The peer closed under the session: fail the running turn. */
    peerClosed(message: string): void;
}

const APPROVAL_VALUES: readonly AskForApproval[] = ['untrusted', 'on-request', 'never'];
const SANDBOX_VALUES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export function sandboxMode(policy: SandboxPolicy | SandboxMode | undefined): SandboxMode | undefined {
    if (!policy) return undefined;
    if (typeof policy === 'string') return policy;
    const type: string = policy.type;
    return type === 'dangerFullAccess' ? 'danger-full-access' : type === 'readOnly' ? 'read-only' : type === 'workspaceWrite' ? 'workspace-write' : undefined;
}

/** The `turn/start` policy for a sandbox mode — the network stays off, `cwd` is the only writable root. */
export function toSandboxPolicy(mode: SandboxMode): SandboxPolicyParam {
    switch (mode) {
        case 'read-only':
            return { type: 'readOnly', networkAccess: false };
        case 'workspace-write':
            return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
        case 'danger-full-access':
            return { type: 'dangerFullAccess' };
    }
}

/** A config option whose `current` is always one of its `values`, even when Codex reports a mode we do not model. */
function configOption(id: string, label: string, values: readonly string[], current: string, unlisted: string): ConfigOption {
    const listed = values.map((v) => ({ id: v }));
    return { id, label, values: values.includes(current) ? listed : [...listed, { id: current, label: unlisted }], current };
}

function toUserInput(input: PromptInput): UserInput[] {
    const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input;
    const out: UserInput[] = [];
    for (const p of parts) {
        if (p.type === 'text') out.push({ type: 'text', text: p.text, text_elements: [] });
        else if (p.type === 'image') out.push({ type: 'image', url: p.url ?? `data:${p.mediaType};base64,${p.data ?? ''}` });
        else if (p.type === 'file' || p.type === 'resource') throw new AgentError('protocol_error', `[sigx ai-agent-codex-cli] Codex accepts text and image parts; got "${p.type}"`);
    }
    return out;
}

function outputSchemaOf(options: PromptOptions | undefined): { json: JsonSchema; standard?: StandardSchemaV1 } | undefined {
    const schema = options?.output?.schema;
    if (!schema) return undefined;
    if ('~standard' in schema) {
        const conv = (schema as StandardSchemaV1)['~standard'].jsonSchema;
        const json = conv?.input({ target: 'draft-2020-12' });
        if (!json) throw new AgentError('protocol_error', '[sigx ai-agent-codex-cli] structured output needs a JSON Schema; the Standard Schema has no converter');
        return { json, standard: schema as StandardSchemaV1 };
    }
    return { json: schema as JsonSchema };
}

export function createCodexSession(deps: CodexSessionDeps): CodexSession {
    const { peer, tools, options } = deps;
    const threadId = deps.thread.thread.id;
    const log = createEventLog({ sessionId: threadId, epoch: deps.epoch });
    const core = createSessionCore({
        id: threadId,
        log,
        ...(options.policy ? { policy: options.policy } : {}),
        interactive: options.interactive ?? true,
        ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        // A prompt during a turn is `turn/steer` on the running Codex turn.
        steer: true,
        // Refused before any event, for prompts and steers alike.
        promptParts: 'text+image',
        // Sub-agents are reported on this thread and their own threads are routed here: they can be cancelled and answered.
        subagents: 'control'
    });
    /** Sub-agent threads seen on this thread — across turns, since one can outlive the turn that spawned it. */
    const agents: SubAgents = new Map();

    /** What the session tracks about a sub-agent's own thread. */
    interface ChildThread {
        /** The child's running Codex turn, for `turn/interrupt`. */
        turnId?: string;
        mapper?: TurnMapper;
        /**
         * A pending `cancel({ agentId })` and the child turn it interrupts (unset until that
         * turn starts). Spent when that turn ends, however it ends.
         */
        cancel?: { turnId?: string };
        /** Codex's nickname or role for it, when the thread announced one. */
        actor?: string;
        turns: number;
    }
    const children = new Map<string, ChildThread>();
    const childOf = (childThreadId: string): ChildThread => {
        let child = children.get(childThreadId);
        if (!child) {
            child = { turns: 0 };
            children.set(childThreadId, child);
        }
        return child;
    };
    /**
     * Where a sub-agent's events go: the running host turn while there is one,
     * else the session log (a sub-agent can outlive the turn that spawned it).
     * Events inside the child sit under its spawn call.
     */
    const childEmitter =
        (callId: string | undefined) =>
        (e: UnstampedEvent): void => {
            const event = callId !== undefined && e.parentCallId === undefined ? { ...e, parentCallId: callId } : e;
            const turn = active;
            if (turn && !turn.driver.ended) turn.driver.emit(event);
            else if (!core.closed) core.emit(event);
        };
    const childMapper = (childThreadId: string, child: ChildThread, turnId: string | undefined): TurnMapper => {
        const agent = agents.get(childThreadId);
        const path = agent?.title?.split('/').filter(Boolean).at(-1) ?? agent?.title;
        const actor = child.actor ?? path;
        return createTurnMapper(
            { emit: childEmitter(agent?.callId) },
            { messageId: `a:${agent?.callId ?? childThreadId}:${turnId ?? child.turns}`, agents, onAgent: deps.adoptChild, nested: actor !== undefined ? { actor } : {} }
        );
    };

    // Per-turn overrides `configure()` records and the next `turn/start` applies.
    const overrides: { model?: string; approvalPolicy?: AskForApproval; sandbox?: SandboxMode; effort?: string } = {};
    let config: ConfigOption[] = [
        { id: 'model', label: 'Model', values: deps.models.length ? deps.models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) })) : [{ id: deps.thread.model }], current: deps.thread.model },
        configOption('approvalPolicy', 'Approval policy', APPROVAL_VALUES, typeof deps.thread.approvalPolicy === 'string' ? deps.thread.approvalPolicy : 'granular', 'Granular (managed by Codex)'),
        configOption('sandbox', 'Sandbox', SANDBOX_VALUES, sandboxMode(deps.thread.sandbox) ?? 'unknown', 'Unknown'),
        ...(deps.thread.reasoningEffort ? [{ id: 'effort', label: 'Reasoning effort', values: [{ id: deps.thread.reasoningEffort }], current: deps.thread.reasoningEffort }] : [])
    ];
    core.emit({ type: 'config', options: config });

    interface ActiveTurn {
        readonly driver: TurnDriver;
        readonly ctx: TurnContext;
        readonly mapper: TurnMapper;
        codexTurnId?: string;
        /** Codex's turn id once `turn/start` answered; rejects when it failed. */
        readonly started: Promise<string>;
        /** Notifications that arrived before `turn/start` answered with Codex's turn id. */
        readonly early: { method: string; params: { readonly turnId?: string } & Record<string, unknown> }[];
        /** Steering inputs delivered so far — numbers the extra `user-message`s. */
        steers: number;
    }
    let active: ActiveTurn | undefined;

    /**
     * Steering input for the running turn: `turn/steer` against the Codex turn
     * (waiting for `turn/start` to answer first), then the `user-message` the
     * transcript shows. The core hands the caller the running turn's handle
     * before this runs, so a refusal cannot fail that prompt — it is reported
     * as a recoverable `error` inside the turn and the turn goes on.
     */
    const steer = async (turn: ActiveTurn, parts: readonly PromptPart[]): Promise<void> => {
        const { driver } = turn;
        // The turn is over (or was cancelled) before the input reached it: a
        // session-level notice, since the turn can no longer carry events.
        const undelivered = () => {
            if (driver.signal.aborted) return;
            core.emit({ type: 'error', code: 'protocol_error', message: `[sigx ai-agent-codex-cli] steering input arrived after turn "${driver.turnId}" ended and was not delivered`, recoverable: true });
        };
        let codexTurnId: string;
        try {
            codexTurnId = await turn.started;
        } catch {
            return; // the turn itself failed to start; its own error ends it
        }
        if (driver.ended) return undelivered();
        try {
            const params: TurnSteerParams = { threadId, expectedTurnId: codexTurnId, input: toUserInput(parts) };
            await peer.request<TurnSteerResponse>(CODEX_METHODS.turnSteer, params, { signal: driver.signal });
            if (driver.ended) return undelivered();
            driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}:${++turn.steers}`, parts: [...parts] });
        } catch (e) {
            if (driver.ended) return undelivered();
            if (driver.signal.aborted) return;
            const message = e instanceof Error ? e.message : String(e);
            driver.emit({ type: 'error', code: 'protocol_error', message: `[sigx ai-agent-codex-cli] turn/steer was refused: ${message}`, recoverable: true });
        }
    };

    /** A Codex request through the running host turn's policy; `parentCallId` nests it under a sub-agent's spawn call. */
    const answer = (turn: ActiveTurn, mapper: TurnMapper, method: string, params: unknown, ctx: RequestContext, parentCallId?: string): Promise<unknown> => {
        const resolve = (request: Parameters<TurnContext['resolve']>[0]) => turn.ctx.resolve(request, parentCallId !== undefined ? { parentCallId } : undefined);
        switch (method) {
            case CODEX_METHODS.commandApproval:
                return approveCommand(params as CommandExecutionRequestApprovalParams, resolve);
            case CODEX_METHODS.fileChangeApproval:
                return approveFileChange(params as FileChangeRequestApprovalParams, resolve);
            case CODEX_METHODS.permissionsApproval:
                return approvePermissions(params as PermissionsRequestApprovalParams, resolve);
            case CODEX_METHODS.userInput:
                return askUserInput(params as ToolRequestUserInputParams, resolve);
            case CODEX_METHODS.toolCall: {
                const p = params as DynamicToolCallParams;
                return callDynamicTool(tools, p, {
                    signal: ctx.signal,
                    resolve,
                    onStatus: (status, message) => mapper.toolStatus(p.callId, status, message)
                });
            }
            default:
                return Promise.reject(new AgentError('protocol_error', `[sigx ai-agent-codex-cli] unsupported request "${method}"`));
        }
    };

    const session: CodexSession = {
        id: threadId,
        threadId,
        get ref(): SessionRef {
            // `epoch` travels with the ref so a caller that persists it verbatim and
            // resumes again keeps advancing the epoch instead of re-using one.
            return { agent: deps.agentId, v: 1, id: threadId, data: { cwd: deps.cwd, epoch: log.epoch } };
        },
        prompt(input, promptOptions) {
            return core.startTurn(input, promptOptions, async (driver, ctx) => {
                const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : [...input];
                driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                const mapper = createTurnMapper(driver, { messageId: `a:${driver.turnId}:0`, agents, onAgent: deps.adoptChild });
                let startedOk!: (id: string) => void;
                let startedFailed!: (e: unknown) => void;
                const started = new Promise<string>((resolve, reject) => {
                    startedOk = resolve;
                    startedFailed = reject;
                });
                started.catch(() => {}); // observed by `steer` only when there is one
                const turn: ActiveTurn = { driver, ctx, mapper, started, early: [], steers: 0 };
                active = turn;
                ctx.onSteer((parts) => void steer(turn, parts));
                const output = outputSchemaOf(promptOptions);
                const params: TurnStartParams = {
                    threadId,
                    input: toUserInput(input),
                    ...(output ? { outputSchema: output.json as TurnStartParams['outputSchema'] } : {}),
                    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
                    ...(overrides.approvalPolicy !== undefined ? { approvalPolicy: overrides.approvalPolicy } : {}),
                    ...(overrides.sandbox !== undefined ? { sandboxPolicy: toSandboxPolicy(overrides.sandbox) } : {}),
                    ...(overrides.effort !== undefined ? { effort: overrides.effort } : {})
                };
                try {
                    const response = await peer.request<TurnStartResponse>(CODEX_METHODS.turnStart, params, { signal: driver.signal });
                    turn.codexTurnId = response.turn.id;
                    driver.emit({ type: 'ext', ns: CODEX_CLI_NS, name: 'turn', data: { turnId: response.turn.id } });
                    for (const n of turn.early.splice(0)) if (n.params.turnId === undefined || n.params.turnId === turn.codexTurnId) mapper.notify(n.method, n.params);
                    startedOk(response.turn.id);
                } catch (e) {
                    startedFailed(e);
                    if (driver.signal.aborted) return;
                    throw e;
                }
                // Cancel = interrupt; Codex then completes the turn as `interrupted`.
                const onAbort = () => {
                    if (turn.codexTurnId) void deps.interrupt(threadId, turn.codexTurnId);
                };
                driver.signal.addEventListener('abort', onAbort, { once: true });
                try {
                    const outcome = await mapper.outcome;
                    let result: unknown;
                    let error = outcome.error;
                    let stopReason = outcome.stopReason;
                    if (output && stopReason === 'end_turn') {
                        try {
                            const raw: unknown = JSON.parse(outcome.finalText);
                            result = output.standard ? await validateWith(output.standard, raw, 'The output did not match the schema') : raw;
                        } catch (e) {
                            stopReason = 'error';
                            error = { code: 'provider_error', message: e instanceof Error ? e.message : String(e) };
                            driver.emit({ type: 'error', code: 'provider_error', message: error.message, recoverable: false });
                        }
                    }
                    driver.end({ stopReason, ...(outcome.usage ? { usage: outcome.usage } : {}), ...(result !== undefined ? { output: result } : {}), ...(error ? { error } : {}) });
                } finally {
                    driver.signal.removeEventListener('abort', onAbort);
                    if (active === turn) active = undefined;
                }
            });
        },
        respond: (requestId, decision) => core.respond(requestId, decision),
        async cancel(target) {
            if (target?.agentId === undefined || target.agentId === threadId) return core.cancel();
            const agent = agents.get(target.agentId);
            if (!agent || AGENT_TERMINAL.has(agent.status)) throw new AgentError('protocol_error', `[sigx ai-agent-codex-cli] thread "${threadId}" has no running sub-agent "${target.agentId}"`);
            const child = childOf(target.agentId);
            // One cancel targets one turn: the running one, or — for a child between turns
            // (not started yet, or waiting on the host) — the next one it starts.
            child.cancel = child.turnId !== undefined ? { turnId: child.turnId } : {};
            if (child.turnId !== undefined) await deps.interrupt(target.agentId, child.turnId);
        },
        async configure(patch) {
            if (patch.model !== undefined) overrides.model = patch.model;
            if (patch.approvalPolicy !== undefined && (APPROVAL_VALUES as readonly string[]).includes(patch.approvalPolicy)) overrides.approvalPolicy = patch.approvalPolicy as AskForApproval;
            if (patch.sandbox !== undefined && (SANDBOX_VALUES as readonly string[]).includes(patch.sandbox)) overrides.sandbox = patch.sandbox as SandboxMode;
            if (patch.effort !== undefined) overrides.effort = patch.effort;
            config = config.map((o) => (patch[o.id] !== undefined ? { ...o, current: patch[o.id]! } : o));
            core.emit({ type: 'config', options: config });
        },
        subscribe: (from) => core.subscribe(from),
        async close() {
            // The thread goes with the session, and its sub-agents with the thread.
            if (!core.closed) settleSubAgents(agents, 'cancelled', (e) => core.emit(e));
            children.clear();
            await core.close();
            deps.onClose(threadId);
        },
        ownsThread: (id) => agents.has(id),
        handleChildNotification(childThreadId, method, params) {
            if (core.closed) return;
            const child = childOf(childThreadId);
            const agent = agents.get(childThreadId);
            switch (method) {
                case CODEX_METHODS.threadStarted: {
                    const thread = params.thread as Thread | undefined;
                    const name = thread?.agentNickname ?? thread?.agentRole;
                    if (name) child.actor = name;
                    return;
                }
                case CODEX_METHODS.turnStarted: {
                    // Named like the host path does: a top-level `turnId`, else the `turn` object.
                    const turnId = params.turnId ?? (params.turn as { id?: string } | undefined)?.id;
                    child.turns++;
                    child.turnId = turnId;
                    child.mapper = childMapper(childThreadId, child, turnId);
                    if (child.cancel && child.cancel.turnId === undefined && turnId !== undefined) {
                        child.cancel.turnId = turnId;
                        void deps.interrupt(childThreadId, turnId);
                    }
                    return;
                }
                case CODEX_METHODS.tokenUsage: {
                    if (!agent) return;
                    const p = params as unknown as ThreadTokenUsageUpdatedNotification;
                    updateSubAgent(agents, childEmitter(undefined), childThreadId, { status: agent.status, ...(agent.summary !== undefined ? { summary: agent.summary } : {}), usage: toUsage(p.tokenUsage.total) });
                    return;
                }
                case CODEX_METHODS.turnCompleted: {
                    const p = params as unknown as Partial<TurnCompletedNotification>;
                    const completedId = params.turnId ?? p.turn?.id;
                    child.mapper?.notify(method, params);
                    child.mapper = undefined;
                    child.turnId = undefined;
                    if (child.cancel?.turnId !== undefined && child.cancel.turnId === completedId) {
                        const interrupted = p.turn?.status === 'interrupted';
                        child.cancel = undefined;
                        // The interrupt can lose the race to the turn finishing on its own: the
                        // cancel is then spent and the agent carries on.
                        if (interrupted) updateSubAgent(agents, childEmitter(undefined), childThreadId, { status: 'cancelled' });
                    }
                    return;
                }
                default: {
                    // Thread status, MCP startup and the like are the child's bookkeeping, not its transcript.
                    if (!method.startsWith('item/') && method !== CODEX_METHODS.turnPlan && method !== CODEX_METHODS.turnDiff) return;
                    child.mapper ??= childMapper(childThreadId, child, child.turnId);
                    child.mapper.notify(method, params);
                }
            }
        },
        async handleChildRequest(childThreadId, method, params, ctx) {
            const turn = active;
            if (!turn) throw new AgentError('protocol_error', `[sigx ai-agent-codex-cli] "${method}" from sub-agent thread "${childThreadId}" arrived with no turn running on thread "${threadId}"`);
            const child = childOf(childThreadId);
            child.mapper ??= childMapper(childThreadId, child, child.turnId);
            return answer(turn, child.mapper, method, params, ctx, agents.get(childThreadId)?.callId);
        },
        handleNotification(method, params) {
            if (!active) {
                if (method !== CODEX_METHODS.threadStarted && method !== CODEX_METHODS.threadStatusChanged) core.emit({ type: 'ext', ns: CODEX_CLI_NS, name: method, data: params });
                return;
            }
            if (active.codexTurnId === undefined) {
                active.early.push({ method, params });
                return;
            }
            const turnId = params.turnId ?? (params.turn as { id?: string } | undefined)?.id;
            if (turnId !== undefined && turnId !== active.codexTurnId) return;
            active.mapper.notify(method, params);
        },
        async handleRequest(method, params, ctx) {
            const turn = active;
            if (!turn) throw new AgentError('protocol_error', `[sigx ai-agent-codex-cli] "${method}" arrived with no turn running on thread "${threadId}"`);
            return answer(turn, turn.mapper, method, params, ctx);
        },
        peerClosed(message) {
            const turn = active;
            if (!turn || turn.driver.ended) return;
            turn.driver.emit({ type: 'error', code: 'process_exited', message, recoverable: false });
            turn.driver.end({ stopReason: 'error', error: { code: 'process_exited', message } });
            active = undefined;
        }
    };
    return session;
}
