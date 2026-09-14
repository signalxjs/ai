/**
 * A Copilot session as an `AgentSession`. Each `prompt()` is one `send()`
 * whose events flow through the turn mapper into the session log until the
 * runtime goes idle; the runtime's questions (permissions, `ask_user`, our
 * own tools) are answered through the session's policy while the turn runs.
 *
 * The SDK session is created by the provider with the callbacks wired to
 * THIS session's state (`onEvent`, `onPermissionRequest`, the tool
 * handlers), so nothing that happens during creation is missed.
 */

import type { ModelInfo, SessionEvent } from '@github/copilot-sdk';
import type { AnyTool } from '@sigx/ai';
import type { AgentSession, ConfigValue, SessionRef, TurnContext, TurnDriver, UnstampedEvent } from '@sigx/ai-agent';
import { AgentError, createEventLog, createSessionCore, toPromptParts, partsText } from '@sigx/ai-agent';
import { COPILOT_NS, type CopilotSessionLike, type CopilotSessionOptions } from './options.js';
import { createPermissionHandler, createUserInputHandler, type PermissionTarget } from './permissions.js';
import { REASONING_EFFORTS, configOptions, type ConfigState } from './request.js';
import { AGENT_TERMINAL, createTurnMapper, emptyUsage, isChatter, settleSubAgents, type SessionUsage, type SubAgents, type TurnMapper } from './stream.js';
import { toCopilotTools, type ToolTarget } from './tools.js';

export interface CopilotSessionDeps {
    readonly agentId: string;
    readonly sessionId: string;
    readonly cwd: string;
    readonly tools: readonly AnyTool[];
    readonly options: CopilotSessionOptions;
    /** The models to offer, and what the runtime said about them (efforts). */
    readonly models: readonly ConfigValue[];
    readonly modelInfos: readonly ModelInfo[];
    readonly epoch: number;
    readonly errorSettleMs: number;
    /** Called when the session closes so the agent forgets it. */
    readonly onClose: (sessionId: string) => void;
}

/** The session plus what the provider wires into the SDK session's config. */
export interface CopilotSession extends AgentSession {
    /** The SDK callbacks and tools for `createSession` / `resumeSession`. */
    readonly hooks: {
        readonly onEvent: (event: SessionEvent) => void;
        readonly onPermissionRequest: ReturnType<typeof createPermissionHandler>;
        readonly onUserInputRequest: ReturnType<typeof createUserInputHandler>;
        readonly tools: ReturnType<typeof toCopilotTools>;
    };
    /** The SDK session, once created. */
    attach(sdk: CopilotSessionLike): void;
    /** The runtime is gone: fail the running turn. */
    runtimeClosed(message: string): void;
}

export function createCopilotSession(deps: CopilotSessionDeps): CopilotSession {
    const { options, tools, sessionId } = deps;
    const log = createEventLog({ sessionId, epoch: deps.epoch });
    const core = createSessionCore({
        id: sessionId,
        log,
        ...(options.policy ? { policy: options.policy } : {}),
        interactive: options.interactive ?? true,
        ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        // A second prompt waits: the runtime queues messages, but a queued one starts its own turn.
        steer: false,
        promptParts: 'text',
        // Sub-agents are reported (`subagent.*`, nested events); the SDK has no per-agent cancel.
        subagents: 'observe'
    });
    const agents: SubAgents = new Map();
    const usage: SessionUsage = { usage: emptyUsage() };
    // What the session advertises: the model once the runtime named it
    // (`session.start`), the effort when either side said. Every `config`
    // event carries the WHOLE list.
    const config: ConfigState = {
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {})
    };
    let advertised = false;
    const announceConfig = () => {
        const list = configOptions(config, deps.models, deps.modelInfos);
        if (!list.length || core.closed) return;
        advertised = true;
        core.emit({ type: 'config', options: list });
    };
    announceConfig();

    let sdk: CopilotSessionLike | undefined;
    /** Events that arrived before `attach()` — the runtime speaks during creation. */
    const early: SessionEvent[] = [];

    interface ActiveTurn {
        readonly driver: TurnDriver;
        readonly ctx: TurnContext;
        readonly mapper: TurnMapper;
        /** Calls whose permission `onPermissionRequest` already resolved. */
        readonly resolvedCalls: Set<string>;
    }
    let active: ActiveTurn | undefined;

    /** Session-level bookkeeping every event gets, whether or not a turn runs. Returns `true` when the event is consumed. */
    const track = (event: SessionEvent): boolean => {
        switch (event.type) {
            case 'session.start':
            case 'session.resume': {
                const d = event.data as { selectedModel?: string; reasoningEffort?: string };
                if (d.selectedModel !== undefined) config.model = d.selectedModel;
                if (d.reasoningEffort !== undefined && config.reasoningEffort === undefined) config.reasoningEffort = d.reasoningEffort;
                if (!advertised) announceConfig();
                return true;
            }
            case 'session.model_change': {
                const d = event.data;
                const changed = d.newModel !== config.model;
                config.model = d.newModel;
                if (changed) announceConfig();
                return true;
            }
            default:
                return false;
        }
    };
    const onEvent = (event: SessionEvent) => {
        if (core.closed) return;
        if (!sdk) {
            early.push(event);
            return;
        }
        if (track(event)) return;
        if (active) active.mapper.handle(event);
        else if (!isTurnBound(event.type) && !isChatter(event.type)) core.emit({ type: 'ext', ns: COPILOT_NS, name: event.type, data: event.data ?? null });
    };

    const permissionTarget = (): PermissionTarget | undefined => {
        const turn = active;
        if (!turn) return undefined;
        return {
            ctx: turn.ctx,
            announce: (callId, name, input) => turn.mapper.announce(callId, name, input),
            markDenied: (callId, message) => turn.mapper.markDenied(callId, message),
            emit: (e: UnstampedEvent) => {
                turn.driver.emit(e);
            }
        };
    };
    const toolTarget = (): ToolTarget | undefined => {
        const turn = active;
        if (!turn) return undefined;
        return {
            ctx: turn.ctx,
            signal: turn.driver.signal,
            resolved: (callId) => turn.resolvedCalls.has(callId),
            announce: (callId, name, input) => turn.mapper.announce(callId, name, input),
            status: (callId, status, detail) => turn.mapper.status(callId, status, detail)
        };
    };
    const onPermissionRequest = createPermissionHandler(permissionTarget);
    // A client tool's permission resolves here first; the handler then runs it without asking again.
    const onPermissionRequestTracked: typeof onPermissionRequest = (request, invocation) => {
        if (request.kind === 'custom-tool' && request.toolCallId !== undefined) active?.resolvedCalls.add(request.toolCallId);
        return onPermissionRequest(request, invocation);
    };

    const session: CopilotSession = {
        id: sessionId,
        get ref(): SessionRef {
            // `epoch` travels with the ref so a caller that persists it verbatim and
            // resumes again keeps advancing the epoch instead of re-using one.
            return { agent: deps.agentId, v: 1, id: sessionId, data: { cwd: deps.cwd, epoch: log.epoch } };
        },
        hooks: {
            onEvent,
            onPermissionRequest: onPermissionRequestTracked,
            onUserInputRequest: createUserInputHandler(permissionTarget),
            tools: toCopilotTools(tools, toolTarget)
        },
        attach(created) {
            sdk = created;
            for (const e of early.splice(0)) onEvent(e);
        },
        prompt(input, promptOptions) {
            return core.startTurn(input, promptOptions, async (driver, ctx) => {
                if (!sdk) throw new AgentError('protocol_error', '[sigx ai-agent-copilot] the session is not attached to the runtime');
                const parts = toPromptParts(input);
                driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                const mapper = createTurnMapper(driver, {
                    messageId: `a:${driver.turnId}:0`,
                    agents,
                    usage,
                    errorSettleMs: deps.errorSettleMs,
                    cancelled: () => driver.signal.aborted
                });
                const turn: ActiveTurn = { driver, ctx, mapper, resolvedCalls: new Set() };
                active = turn;
                // Cancel = abort; the runtime then goes idle with `aborted`.
                const onAbort = () => {
                    void sdk?.abort().catch(() => {});
                };
                driver.signal.addEventListener('abort', onAbort, { once: true });
                try {
                    try {
                        await sdk.send({ prompt: partsText(parts) });
                    } catch (e) {
                        if (driver.signal.aborted) return;
                        throw sendError(e);
                    }
                    const outcome = await mapper.outcome;
                    driver.end({ stopReason: outcome.stopReason, ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.error ? { error: outcome.error } : {}) });
                } finally {
                    driver.signal.removeEventListener('abort', onAbort);
                    if (active === turn) active = undefined;
                }
            });
        },
        respond: (requestId, decision) => core.respond(requestId, decision),
        cancel: (target) => {
            if (target?.agentId !== undefined && target.agentId !== sessionId) {
                const agent = agents.get(target.agentId);
                if (!agent || AGENT_TERMINAL.has(agent.status)) return Promise.reject(new AgentError('protocol_error', `[sigx ai-agent-copilot] session "${sessionId}" has no running sub-agent "${target.agentId}"`));
                return Promise.reject(new AgentError('protocol_error', '[sigx ai-agent-copilot] Copilot cannot cancel one sub-agent; cancel() the turn'));
            }
            return core.cancel();
        },
        async configure(patch) {
            if (!sdk) throw new AgentError('protocol_error', '[sigx ai-agent-copilot] the session is not attached to the runtime');
            const model = patch.model ?? config.model;
            const effort = patch.reasoningEffort;
            if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
                throw new AgentError('protocol_error', `[sigx ai-agent-copilot] reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}, not "${effort}"`);
            }
            if (patch.model === undefined && effort === undefined) return;
            if (model === undefined) throw new AgentError('protocol_error', '[sigx ai-agent-copilot] the session has no model yet to set the effort on');
            // Recorded before the call: the runtime's own `session.model_change` for it
            // arrives while `setModel` is in flight, and must not read as a second change.
            const previous = { ...config };
            config.model = model;
            if (effort !== undefined) config.reasoningEffort = effort;
            try {
                await sdk.setModel(model, effort !== undefined ? { reasoningEffort: effort as (typeof REASONING_EFFORTS)[number] } : {});
            } catch (e) {
                Object.assign(config, previous);
                throw e;
            }
            // The WHOLE list, not just what moved: a `config` event is the options.
            announceConfig();
        },
        subscribe: (from) => core.subscribe(from),
        async close() {
            if (!core.closed) settleSubAgents(agents, 'cancelled', (e) => core.emit(e));
            await core.close();
            const s = sdk;
            sdk = undefined;
            await s?.disconnect().catch(() => {});
            deps.onClose(sessionId);
        },
        runtimeClosed(message) {
            const turn = active;
            if (!turn || turn.driver.ended) return;
            turn.driver.emit({ type: 'error', code: 'process_exited', message, recoverable: false });
            turn.driver.end({ stopReason: 'error', error: { code: 'process_exited', message } });
            active = undefined;
        }
    };
    return session;
}

/** A `send()` the runtime refused: a gone runtime is `process_exited`, anything else the provider's. */
function sendError(e: unknown): AgentError {
    if (e instanceof AgentError) return e;
    const message = e instanceof Error ? e.message : String(e);
    const gone = /disconnect|connection.*(closed|lost)|exited|not connected|EPIPE/i.test(message);
    return new AgentError(gone ? 'process_exited' : 'provider_error', `[sigx ai-agent-copilot] send failed: ${message}`, false, { cause: e });
}

/** Event types that only mean something inside a turn — outside one they are noise, not `ext`. */
function isTurnBound(type: string): boolean {
    return type === 'session.idle' || type === 'user.message' || type.startsWith('assistant.') || type.startsWith('tool.') || type.startsWith('permission.') || type.startsWith('user_input.');
}
