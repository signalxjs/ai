/**
 * A Codex thread as an `AgentSession`. Each `prompt()` is one `turn/start`
 * whose notifications flow through the turn mapper into the session log;
 * Codex's requests (approvals, questions, dynamic tool calls) are answered
 * through the session's policy while the turn runs.
 */

import { validateWith, type AnyTool, type JsonSchema, type StandardSchemaV1 } from '@sigx/ai';
import type { AgentSession, ConfigOption, PromptInput, PromptOptions, SessionRef, TurnDriver, TurnContext } from '@sigx/ai-agent';
import { AgentError, createEventLog, createSessionCore } from '@sigx/ai-agent';
import type { JsonRpcPeer, RequestContext } from '@sigx/ai-agent/harness';
import { approveCommand, approveFileChange, approvePermissions, askUserInput } from './approvals.js';
import type { CodexSessionOptions } from './options.js';
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
    ThreadStartResponse,
    ToolRequestUserInputParams,
    TurnStartParams,
    TurnStartResponse,
    UserInput
} from './schema.js';
import { CODEX_NS, createTurnMapper, type TurnMapper } from './stream.js';
import { callDynamicTool } from './tools.js';

export interface CodexSessionDeps {
    readonly agentId: string;
    readonly peer: JsonRpcPeer;
    /** `turn/interrupt` for a running Codex turn. */
    readonly interrupt: (threadId: string, codexTurnId: string) => Promise<void>;
    readonly thread: ThreadStartResponse;
    readonly cwd: string;
    readonly tools: readonly AnyTool[];
    readonly options: CodexSessionOptions;
    readonly models: readonly { readonly id: string; readonly label?: string }[];
    readonly epoch: number;
    /** Called when the session closes so the agent forgets it. */
    readonly onClose: (threadId: string) => void;
}

/** The session plus the hooks the agent's dispatcher calls. */
export interface CodexSession extends AgentSession {
    readonly threadId: string;
    handleNotification(method: string, params: { readonly threadId?: string; readonly turnId?: string } & Record<string, unknown>): void;
    handleRequest(method: string, params: unknown, ctx: RequestContext): Promise<unknown>;
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
        else if (p.type === 'file' || p.type === 'resource') throw new AgentError('protocol_error', `[sigx ai-agent-codex] Codex accepts text and image parts; got "${p.type}"`);
    }
    return out;
}

function outputSchemaOf(options: PromptOptions | undefined): { json: JsonSchema; standard?: StandardSchemaV1 } | undefined {
    const schema = options?.output?.schema;
    if (!schema) return undefined;
    if ('~standard' in schema) {
        const conv = (schema as StandardSchemaV1)['~standard'].jsonSchema;
        const json = conv?.input({ target: 'draft-2020-12' });
        if (!json) throw new AgentError('protocol_error', '[sigx ai-agent-codex] structured output needs a JSON Schema; the Standard Schema has no converter');
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
        ...(options.signal ? { signal: options.signal } : {})
    });

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
        /** Notifications that arrived before `turn/start` answered with Codex's turn id. */
        readonly early: { method: string; params: { readonly turnId?: string } & Record<string, unknown> }[];
    }
    let active: ActiveTurn | undefined;

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
                const mapper = createTurnMapper(driver, { messageId: `a:${driver.turnId}:0` });
                const turn: ActiveTurn = { driver, ctx, mapper, early: [] };
                active = turn;
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
                    const started = await peer.request<TurnStartResponse>(CODEX_METHODS.turnStart, params, { signal: driver.signal });
                    turn.codexTurnId = started.turn.id;
                    driver.emit({ type: 'ext', ns: CODEX_NS, name: 'turn', data: { turnId: started.turn.id } });
                    for (const n of turn.early.splice(0)) if (n.params.turnId === undefined || n.params.turnId === turn.codexTurnId) mapper.notify(n.method, n.params);
                } catch (e) {
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
        cancel: () => core.cancel(),
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
            await core.close();
            deps.onClose(threadId);
        },
        handleNotification(method, params) {
            if (!active) {
                if (method !== CODEX_METHODS.threadStarted && method !== CODEX_METHODS.threadStatusChanged) core.emit({ type: 'ext', ns: CODEX_NS, name: method, data: params });
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
            if (!turn) throw new AgentError('protocol_error', `[sigx ai-agent-codex] "${method}" arrived with no turn running on thread "${threadId}"`);
            const resolve = (request: Parameters<TurnContext['resolve']>[0]) => turn.ctx.resolve(request);
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
                        onStatus: (status, message) => turn.mapper.toolStatus(p.callId, status, message)
                    });
                }
                default:
                    throw new AgentError('protocol_error', `[sigx ai-agent-codex] unsupported request "${method}"`);
            }
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
