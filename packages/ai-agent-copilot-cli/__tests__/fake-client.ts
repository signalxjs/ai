/**
 * A scripted `CopilotClientLike`: what the SDK's client and session look like
 * from the adapter's side, driven by a per-turn program instead of a runtime.
 * The program speaks the runtime's events (`ctx.emit`), asks permission the
 * way the runtime does (`ctx.ask`, `ctx.askUser`) and runs the session's
 * client tools through their SDK handlers (`ctx.callTool`).
 */

import type { GetAuthStatusResponse, ModelInfo, PermissionRequest, PermissionRequestResult, ResumeSessionConfig, SessionConfig, SessionEvent, SessionListFilter, SessionMetadata, ToolResultObject } from '@github/copilot-sdk';
import type { CopilotClientLike, CopilotSessionLike, UserInputHandler } from '../src/options';

type EventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;
type DataOf<T extends SessionEvent['type']> = EventOf<T>['data'];

export interface FakeTurnContext {
    readonly sessionId: string;
    readonly prompt: string;
    readonly turn: number;
    /** `abort()` was called on the session. */
    readonly aborted: boolean;
    readonly signal: AbortSignal;
    /** A raw session event to every listener (the config's `onEvent` and `on()` handlers). */
    emit<T extends SessionEvent['type']>(type: T, data: DataOf<T>, envelope?: { agentId?: string }): void;
    /** Stream a message: one delta per word, then the complete message. */
    say(text: string, options?: { messageId?: string; agentId?: string; parentToolCallId?: string; deltas?: boolean }): Promise<void>;
    reason(text: string, options?: { reasoningId?: string }): void;
    /** A permission ask, answered by the session's handler. */
    ask(request: PermissionRequest): Promise<PermissionRequestResult>;
    askUser(request: Parameters<UserInputHandler>[0]): ReturnType<UserInputHandler>;
    /**
     * Run one of the session's client tools the way the runtime does: announce
     * it, ask permission (`custom-tool`) unless `skipAsk`, call its handler,
     * report the completion.
     */
    callTool(name: string, args: unknown, options?: { skipAsk?: boolean; toolCallId?: string; agentId?: string }): Promise<ToolResultObject | undefined>;
    /** A built-in tool's execution (a shell command, say) — start, output, complete. */
    builtin(toolCallId: string, toolName: string, args: unknown, result: { output?: string; success?: boolean; error?: string; partial?: readonly string[]; agentId?: string }): Promise<void>;
    usage(u: Partial<DataOf<'assistant.usage'>>): void;
    error(d: Partial<DataOf<'session.error'>> & { message: string }): void;
    /** End the turn; the fake does this itself when the program returns without. */
    idle(aborted?: boolean): void;
    /** Resolves when the client aborts the session. */
    readonly abortRequested: Promise<void>;
}

export type TurnProgram = (ctx: FakeTurnContext) => Promise<void> | void;

export interface FakeClientOptions {
    /** What `getAuthStatus` says. Default authenticated. */
    readonly auth?: Partial<GetAuthStatusResponse>;
    readonly models?: ModelInfo[];
    /** The model `session.start` announces when the config names none. Default `gpt-5`. */
    readonly defaultModel?: string;
    readonly listed?: SessionMetadata[];
    /** `start()` fails with this. */
    readonly failStart?: Error;
    /** `createSession` fails with this. */
    readonly failCreate?: Error;
    /** `send()` fails with this. */
    readonly failSend?: Error;
    /** Emit `session.start` during `createSession` (before it resolves). Default true. */
    readonly startEvent?: boolean;
}

export interface FakeSession extends CopilotSessionLike {
    readonly config: SessionConfig | ResumeSessionConfig;
    readonly resumed: boolean;
    readonly sends: string[];
    readonly aborts: number;
    readonly setModels: { model: string; options: unknown }[];
    readonly disconnects: number;
    readonly model: string;
    /** Deliver an event from outside a program (a model change, a shutdown, …). */
    emit<T extends SessionEvent['type']>(type: T, data: DataOf<T>): void;
}

export interface FakeClient {
    readonly client: CopilotClientLike;
    readonly sessions: FakeSession[];
    readonly starts: number;
    readonly stops: number;
}

export const MODELS: ModelInfo[] = [
    { id: 'gpt-5', name: 'GPT-5', capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 200_000 } }, policy: { state: 'enabled', terms: '' }, supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 200_000 } }, policy: { state: 'enabled', terms: '' } },
    { id: 'o3-mini', name: 'o3-mini', capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 100_000 } }, policy: { state: 'disabled', terms: '' } }
];

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${++counter}`;

export function fakeClient(program: TurnProgram, options: FakeClientOptions = {}): FakeClient {
    const sessions: FakeSession[] = [];
    const state = { starts: 0, stops: 0 };

    const makeSession = (config: SessionConfig | ResumeSessionConfig, sessionId: string, resumed: boolean): FakeSession => {
        const listeners: ((e: SessionEvent) => void)[] = [];
        if (config.onEvent) listeners.push(config.onEvent);
        const sends: string[] = [];
        const setModels: { model: string; options: unknown }[] = [];
        let model = config.model ?? options.defaultModel ?? 'gpt-5';
        let turns = 0;
        let active: { controller: AbortController; abortRequested: () => void; idle: boolean } | undefined;
        const counters = { aborts: 0, disconnects: 0 };
        const envelope = <T extends SessionEvent['type']>(type: T, data: DataOf<T>, extra: { agentId?: string } = {}): SessionEvent =>
            ({ id: nextId('ev'), parentId: null, timestamp: new Date().toISOString(), type, data, ...extra }) as unknown as SessionEvent;
        const dispatch = (event: SessionEvent) => {
            for (const l of [...listeners]) l(event);
        };
        const emit = <T extends SessionEvent['type']>(type: T, data: DataOf<T>, extra?: { agentId?: string }) => dispatch(envelope(type, data, extra));

        const run = (prompt: string) => {
            const controller = new AbortController();
            let abortRequested!: () => void;
            const abortPromise = new Promise<void>((resolve) => {
                abortRequested = resolve;
            });
            const turn = { controller, abortRequested, idle: false };
            active = turn;
            // After an abort the runtime says nothing more for this turn but the idle.
            const turnEmit: typeof emit = (type, data, extra) => {
                if (controller.signal.aborted && type !== 'session.idle' && type !== 'abort') return;
                emit(type, data, extra);
            };
            const ctx: FakeTurnContext = {
                sessionId,
                prompt,
                turn: ++turns,
                get aborted() {
                    return controller.signal.aborted;
                },
                signal: controller.signal,
                abortRequested: abortPromise,
                emit: turnEmit,
                async say(text, o = {}) {
                    const messageId = o.messageId ?? nextId('msg');
                    const extra = o.agentId !== undefined ? { agentId: o.agentId } : {};
                    const parent = o.parentToolCallId !== undefined ? { parentToolCallId: o.parentToolCallId } : {};
                    if (o.deltas !== false) {
                        for (const word of text.split(/(?<= )/)) {
                            turnEmit('assistant.message_delta', { messageId, deltaContent: word, ...parent }, extra);
                            await Promise.resolve();
                        }
                    }
                    turnEmit('assistant.message', { messageId, content: text, ...parent }, extra);
                },
                reason(text, o = {}) {
                    const reasoningId = o.reasoningId ?? nextId('r');
                    turnEmit('assistant.reasoning_delta', { reasoningId, deltaContent: text.slice(0, Math.ceil(text.length / 2)) });
                    turnEmit('assistant.reasoning', { reasoningId, content: text });
                },
                ask: async (request) => {
                    turnEmit('permission.requested', { requestId: nextId('perm'), permissionRequest: request } as DataOf<'permission.requested'>);
                    const handler = config.onPermissionRequest;
                    if (!handler) return { kind: 'user-not-available' };
                    const result = await handler(request, { sessionId });
                    return result.kind === 'attributed' ? result.result : result;
                },
                askUser: async (request) => {
                    const handler = config.onUserInputRequest;
                    if (!handler) throw new Error('no user input handler');
                    return handler(request, { sessionId });
                },
                async callTool(name, args, o = {}) {
                    const tool = config.tools?.find((t) => t.name === name);
                    if (!tool?.handler) throw new Error(`fake: no client tool "${name}"`);
                    const toolCallId = o.toolCallId ?? nextId('call');
                    const extra = o.agentId !== undefined ? { agentId: o.agentId } : {};
                    // The runtime asks before it executes; a denied call never starts.
                    if (!o.skipAsk) {
                        const decision = await ctx.ask({ kind: 'custom-tool', toolCallId, toolName: name, toolDescription: tool.description ?? '', args: args as never });
                        if (decision.kind !== 'approve-once' && decision.kind !== 'approve-for-session') return undefined;
                    }
                    turnEmit('tool.execution_start', { toolCallId, toolName: name, arguments: args as DataOf<'tool.execution_start'>['arguments'] }, extra);
                    let result: ToolResultObject;
                    try {
                        const raw = await tool.handler(args, { sessionId, toolCallId, toolName: name, arguments: args, signal: controller.signal });
                        result = typeof raw === 'string' ? { textResultForLlm: raw, resultType: 'success' } : (raw as ToolResultObject);
                    } catch (e) {
                        result = { textResultForLlm: String(e), resultType: 'failure', error: e instanceof Error ? e.message : String(e) };
                    }
                    if (controller.signal.aborted) return result;
                    const ok = result.resultType === 'success';
                    turnEmit('tool.execution_complete', { toolCallId, success: ok, ...(ok ? { result: { content: result.textResultForLlm } } : { error: { message: result.error ?? result.textResultForLlm } }) }, extra);
                    return result;
                },
                async builtin(toolCallId, toolName, args, result) {
                    const extra = result.agentId !== undefined ? { agentId: result.agentId } : {};
                    turnEmit('tool.execution_start', { toolCallId, toolName, arguments: args as DataOf<'tool.execution_start'>['arguments'] }, extra);
                    for (const chunk of result.partial ?? []) {
                        turnEmit('tool.execution_partial_result', { toolCallId, partialOutput: chunk }, extra);
                        await Promise.resolve();
                    }
                    const success = result.success ?? true;
                    turnEmit('tool.execution_complete', { toolCallId, success, ...(success ? { result: { content: result.output ?? '' } } : { error: { message: result.error ?? 'failed' } }) }, extra);
                },
                usage(u) {
                    turnEmit('assistant.usage', { model, inputTokens: 10, outputTokens: 5, ...u });
                },
                error(d) {
                    turnEmit('session.error', { errorType: 'provider', ...d });
                },
                idle(aborted) {
                    if (turn.idle) return;
                    turn.idle = true;
                    if (active === turn) active = undefined;
                    turnEmit('session.idle', aborted ? { aborted: true } : {});
                }
            };
            emit('assistant.turn_start', { turnId: nextId('turn'), model });
            setTimeout(() => {
                Promise.resolve()
                    .then(() => program(ctx))
                    .catch((e: unknown) => {
                        if (!controller.signal.aborted) throw e;
                    })
                    .finally(() => {
                        if (!turn.idle && !controller.signal.aborted) {
                            emit('assistant.turn_end', { turnId: 't' });
                            ctx.idle();
                        }
                    });
            }, 0);
        };

        const session: FakeSession = {
            sessionId,
            config,
            resumed,
            sends,
            setModels,
            get aborts() {
                return counters.aborts;
            },
            get disconnects() {
                return counters.disconnects;
            },
            get model() {
                return model;
            },
            emit: (type, data) => emit(type, data),
            async send(o) {
                if (options.failSend) throw options.failSend;
                sends.push(o.prompt);
                run(o.prompt);
                return nextId('m');
            },
            async abort() {
                counters.aborts++;
                const turn = active;
                if (!turn) return;
                turn.controller.abort();
                turn.abortRequested();
                emit('abort', { reason: 'user_initiated' });
                // The runtime stops the turn and goes idle.
                setTimeout(() => {
                    if (!turn.idle) {
                        turn.idle = true;
                        if (active === turn) active = undefined;
                        emit('session.idle', { aborted: true });
                    }
                }, 0);
            },
            async setModel(next, o) {
                setModels.push({ model: next, options: o });
                const previous = model;
                model = next;
                emit('session.model_change', { newModel: next, previousModel: previous });
            },
            on(handler) {
                listeners.push(handler);
                return () => {
                    const i = listeners.indexOf(handler);
                    if (i >= 0) listeners.splice(i, 1);
                };
            },
            async disconnect() {
                counters.disconnects++;
            }
        };
        if (options.startEvent !== false) {
            emit(resumed ? 'session.resume' : 'session.start', { sessionId, selectedModel: model, copilotVersion: '1.0.83', producer: 'fake', startTime: new Date().toISOString(), version: 1, ...(resumed ? { resumeTime: new Date().toISOString(), eventCount: 0 } : {}) } as DataOf<'session.start'>);
        }
        return session;
    };

    const client: CopilotClientLike = {
        async start() {
            state.starts++;
            if (options.failStart) throw options.failStart;
        },
        async stop() {
            state.stops++;
            return [];
        },
        async createSession(config) {
            if (options.failCreate) throw options.failCreate;
            const s = makeSession(config, config.sessionId ?? nextId('sess'), false);
            sessions.push(s);
            return s;
        },
        async resumeSession(sessionId, config) {
            const s = makeSession(config, sessionId, true);
            sessions.push(s);
            return s;
        },
        async listSessions(_filter?: SessionListFilter) {
            return options.listed ?? sessions.map((s) => ({ sessionId: s.sessionId, startTime: new Date(0), modifiedTime: new Date(1000), summary: `Session ${s.sessionId}`, isRemote: false, context: { workingDirectory: (s.config as SessionConfig).workingDirectory ?? '/repo' } }));
        },
        async listModels() {
            return options.models ?? MODELS;
        },
        async getAuthStatus() {
            return { isAuthenticated: true, authType: 'user', login: 'octocat', ...options.auth };
        }
    };
    return {
        client,
        sessions,
        get starts() {
            return state.starts;
        },
        get stops() {
            return state.stops;
        }
    };
}

/** A program that streams one reply. */
export const say =
    (text: string): TurnProgram =>
    (ctx) =>
        ctx.say(text);
