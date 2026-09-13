/**
 * `mockAgent` — a scripted, deterministic `Agent` for tests, docs and CI.
 *
 * Each turn plays a list of steps: text (streamed in chunks), tool calls
 * (through the policy, like a real harness), sub-agents (a tool call whose
 * nested script plays under it), input requests, extension events, errors,
 * structured output. Steering input that arrives mid-turn is answered with
 * the `steer` reply between steps. Capabilities are honest: a step the
 * declared capabilities do not cover is skipped, so a reduced mock behaves
 * like a reduced harness.
 */

import type { JsonSchema, UIMessage, Usage } from '@sigx/ai';
import type {
    AgentCapabilities,
    AgentErrorCode,
    ConfigOption,
    ContentBlock,
    ErrorInfo,
    PromptPart,
    RequestOption,
    StopReason,
    ToolAnnotations,
    ToolStatus
} from '../protocol/index.js';
import { AgentError, capabilities as makeCapabilities } from '../protocol/index.js';
import { createGrants } from '../policy/index.js';
import type { Agent, AgentSession, SessionOptions, SessionRef, SessionSummary } from '../session/index.js';
import { createEventLog, createSessionCore } from '../session/index.js';
import type { TurnDriver, TurnContext, TurnEndInit } from '../session/index.js';
import { fromUIMessages } from '../state/index.js';
import { anySignal, isAbort, sleep } from '../utils/abort.js';
import { generateId } from '../utils/id.js';

export interface MockToolStep {
    readonly name: string;
    readonly input?: unknown;
    readonly output?: unknown;
    /** Terminal status after running; default `completed`. */
    readonly status?: 'completed' | 'failed';
    readonly error?: string;
    readonly content?: readonly ContentBlock[];
    readonly title?: string;
    readonly annotations?: ToolAnnotations;
    readonly category?: string;
    readonly source?: 'client' | 'native' | 'mcp';
    /** Session-grant key; default `tool:<name>`. */
    readonly permissionKey?: string;
    /** Simulated run time (abortable). */
    readonly delayMs?: number;
}

/** A tool call that spawns a sub-agent: its `steps` play nested under the call, between `agent-start` and the terminal `agent-update`. */
export interface MockAgentStep {
    /** The spawning tool's name — and the sub-agent's `kind` unless one is given. */
    readonly name: string;
    readonly kind?: string;
    /** The sub-agent's title; default `name`. */
    readonly title?: string;
    readonly input?: unknown;
    /** The sub-agent's own script (may spawn agents of its own). */
    readonly steps: readonly MockStep[];
    /** The sub-agent's result — also the spawning call's output. Falls back to a nested `output` step. */
    readonly output?: unknown;
    /** Terminal status; default `completed`. */
    readonly status?: 'completed' | 'failed';
    readonly error?: string;
    readonly source?: 'client' | 'native' | 'mcp';
    /** Session-grant key; default `tool:<name>`. */
    readonly permissionKey?: string;
}

export type MockStep =
    | {
          readonly text: string;
          readonly reasoning?: string;
          readonly actor?: string;
          /** Characters per delta; default splits on word boundaries. */
          readonly chunkSize?: number;
          /** Milliseconds between deltas; default 0. */
          readonly delayMs?: number;
      }
    | { readonly tool: MockToolStep }
    | { readonly agent: MockAgentStep }
    | { readonly request: { readonly kind: 'input'; readonly message?: string; readonly options?: readonly RequestOption[]; readonly schema?: JsonSchema } }
    | { readonly ext: { readonly ns: string; readonly name: string; readonly data: unknown } }
    | { readonly error: { readonly code: AgentErrorCode; readonly message: string; readonly recoverable?: boolean } }
    | { readonly output: unknown }
    | { readonly usage: Usage; readonly costUsd?: number }
    | { readonly config: readonly ConfigOption[] }
    | { readonly stop: StopReason };

export interface MockRespondContext {
    /** Answers collected from `input` requests so far, in order. */
    readonly answers: readonly unknown[];
    readonly session: AgentSession;
    readonly options: SessionOptions;
}

export interface MockAgentOptions {
    /** Default `'mock'`. */
    readonly id?: string;
    readonly capabilities?: Partial<AgentCapabilities>;
    /** One step list per turn; a turn past the end plays a one-line text. */
    readonly script?: ReadonlyArray<readonly MockStep[]>;
    /** Compute a turn's steps; wins over `script`. */
    readonly respond?: (input: readonly PromptPart[], turn: number, ctx: MockRespondContext) => readonly MockStep[] | Promise<readonly MockStep[]>;
    /**
     * The steps that answer steering input (a `prompt()` while the turn runs);
     * they play in a new assistant message before the turn's next step.
     * Default: one line of text.
     */
    readonly steer?: (input: readonly PromptPart[], turn: number, ctx: MockRespondContext) => readonly MockStep[] | Promise<readonly MockStep[]>;
}

export interface MockAgent extends Agent {
    /** Every session opened, in order. */
    readonly sessions: readonly AgentSession[];
}

/** The mock's default: everything an in-process agent can honour. */
export const MOCK_CAPABILITIES: AgentCapabilities = makeCapabilities({
    resume: 'portable',
    fork: true,
    listSessions: true,
    cancel: true,
    steer: true,
    config: true,
    structuredOutput: true,
    promptParts: 'text+image+file',
    tools: 'native',
    permissions: 'every-call',
    importTranscript: true,
    subagents: 'control'
});

/** What the mock's `SessionRef.data` carries — or, for `importTranscript`, a portable `messages` list. */
interface MockRefData {
    readonly turn: number;
    readonly answers: readonly unknown[];
    readonly grants: readonly string[];
    readonly epoch: number;
    readonly messages?: readonly UIMessage[];
}

/** What a script accumulates towards its `turn-end` (or, nested, its `agent-update`). */
interface Accumulator {
    stop: StopReason;
    usage?: Usage;
    costUsd?: number;
    output?: unknown;
}

/** Where a script plays: the (possibly nested) driver and context, and the assistant message its parts go to. */
interface Frame {
    readonly driver: TurnDriver;
    readonly ctx: TurnContext;
    readonly acc: Accumulator;
    /** Inside a sub-agent: usage stays on the agent, output needs no capability. */
    readonly nested: boolean;
    messageId: string;
    partSeq: number;
    /** Top level only: answer the steering input queued so far; an outcome ends the turn early. */
    readonly drain?: (frame: Frame) => Promise<TurnEndInit | undefined>;
}

export function mockAgent(options: MockAgentOptions = {}): MockAgent {
    const id = options.id ?? 'mock';
    const caps = { ...MOCK_CAPABILITIES, ...options.capabilities };
    const sessions: AgentSession[] = [];
    let callSeq = 0;
    let agentSeq = 0;

    async function openSession(sessionOptions: SessionOptions = {}): Promise<AgentSession> {
        let turnIndex = 0;
        const answers: unknown[] = [];
        let sessionId = generateId('sess');
        let epoch = 1;
        let grants: readonly string[] = [];
        let imported: readonly UIMessage[] | undefined;
        if (sessionOptions.resume) {
            if (!caps.resume) throw new AgentError('protocol_error', `[sigx ai-agent] agent "${id}" cannot resume sessions`);
            if (sessionOptions.resume.agent !== id) throw new AgentError('protocol_error', `[sigx ai-agent] session ref belongs to agent "${sessionOptions.resume.agent}", not "${id}"`);
            const data = (sessionOptions.resume.data ?? {}) as Partial<MockRefData>;
            if (data.messages) {
                if (!caps.importTranscript) throw new AgentError('protocol_error', `[sigx ai-agent] agent "${id}" cannot import transcripts`);
                imported = data.messages;
            }
            turnIndex = data.turn ?? imported?.filter((m) => m.role === 'user').length ?? 0;
            answers.push(...(data.answers ?? []));
            if (sessionOptions.fork) {
                // A fork is a new session: the grants stay with the one that gave them.
                if (!caps.fork) throw new AgentError('protocol_error', `[sigx ai-agent] agent "${id}" cannot fork sessions`);
            } else {
                sessionId = sessionOptions.resume.id;
                epoch = (data.epoch ?? 1) + 1;
                grants = data.grants ?? [];
            }
        }
        const log = createEventLog({ sessionId, epoch });
        if (imported) {
            // The history plays first, so a subscriber from `{ epoch: 0, seq: 0 }` sees the whole conversation.
            for (const e of fromUIMessages(imported, { sessionId }).events) {
                const { sessionId: _s, epoch: _e, seq: _q, ...payload } = e;
                log.append(payload);
            }
        }
        const core = createSessionCore({
            id: sessionId,
            log,
            grants: createGrants(grants),
            ...(sessionOptions.policy ? { policy: sessionOptions.policy } : {}),
            interactive: sessionOptions.interactive ?? true,
            ...(sessionOptions.requestTimeoutMs !== undefined ? { requestTimeoutMs: sessionOptions.requestTimeoutMs } : {}),
            ...(sessionOptions.signal ? { signal: sessionOptions.signal } : {}),
            steer: caps.steer,
            subagents: caps.subagents,
            promptParts: caps.promptParts
        });
        let config: ConfigOption[] = [];
        // One abort per running sub-agent, so `cancel({ agentId })` reaches exactly that one.
        const agentAborts = new Map<string, AbortController>();
        core.attach({
            cancel: async (target) => {
                if (target.agentId !== undefined) agentAborts.get(target.agentId)?.abort();
            }
        });

        const ref = (): SessionRef => ({ agent: id, v: 1, id: sessionId, data: { turn: turnIndex, answers: [...answers], grants: core.grants.keys(), epoch: log.epoch } satisfies MockRefData });

        /** The policy's verdict on a call, with the events of a refused one already emitted. */
        async function gate(frame: Frame, callId: string, step: Pick<MockToolStep, 'name' | 'input' | 'annotations' | 'category' | 'source' | 'permissionKey'>): Promise<'allow' | 'deny' | 'cancel'> {
            if (caps.permissions === 'none') return 'allow';
            const resolved = await frame.ctx.resolve({
                kind: 'permission',
                callId,
                toolName: step.name,
                ...(step.input !== undefined ? { input: step.input } : {}),
                ...(step.annotations !== undefined ? { annotations: step.annotations } : {}),
                ...(step.category !== undefined ? { category: step.category } : {}),
                source: step.source ?? 'native',
                permissionKey: step.permissionKey ?? `tool:${step.name}`
            });
            const d = resolved.decision;
            if (d.type === 'cancel') {
                frame.driver.emit({ type: 'tool-update', callId, status: 'cancelled' });
                return 'cancel';
            }
            if (d.type === 'permission' && d.outcome === 'deny') {
                frame.driver.emit({ type: 'tool-update', callId, status: 'denied', ...(d.message !== undefined ? { error: d.message } : {}) });
                return 'deny';
            }
            return 'allow';
        }

        async function play(steps: readonly MockStep[], frame: Frame): Promise<TurnEndInit> {
            const { driver, ctx, acc } = frame;

            const stream = async (kind: 'text' | 'reasoning', text: string, actor: string | undefined, chunkSize: number | undefined, delayMs: number) => {
                const partId = `${frame.messageId}:${frame.partSeq++}`;
                driver.emit({ type: 'part-start', messageId: frame.messageId, partId, kind, ...(actor !== undefined ? { actor } : {}) });
                for (const delta of chunk(text, chunkSize)) {
                    if (driver.signal.aborted) break;
                    if (delayMs > 0) {
                        try {
                            await sleep(delayMs, driver.signal);
                        } catch {
                            break;
                        }
                    }
                    driver.emit({ type: 'part-delta', partId, delta });
                }
                // A cut-off part still closes, so the transcript knows it is done.
                driver.emit({ type: 'part-end', partId });
            };

            for (const step of steps) {
                if (frame.drain) {
                    const early = await frame.drain(frame);
                    if (early) return early;
                }
                if (driver.signal.aborted) return { stopReason: 'cancelled' };
                if ('text' in step) {
                    if (step.reasoning) await stream('reasoning', step.reasoning, step.actor, step.chunkSize, step.delayMs ?? 0);
                    await stream('text', step.text, step.actor, step.chunkSize, step.delayMs ?? 0);
                } else if ('tool' in step) {
                    const t = step.tool;
                    const callId = `call_${++callSeq}`;
                    driver.emit({
                        type: 'tool-call',
                        callId,
                        name: t.name,
                        messageId: frame.messageId,
                        ...(t.input !== undefined ? { input: t.input } : {}),
                        ...(t.title !== undefined ? { title: t.title } : {}),
                        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
                        ...(t.category !== undefined ? { category: t.category } : {})
                    });
                    driver.emit({ type: 'tool-update', callId, status: 'pending' });
                    const verdict = await gate(frame, callId, t);
                    if (verdict === 'cancel') return { stopReason: 'cancelled' };
                    if (verdict === 'deny') continue;
                    driver.emit({ type: 'tool-update', callId, status: 'in_progress' });
                    if (t.delayMs) {
                        try {
                            await sleep(t.delayMs, driver.signal);
                        } catch {
                            driver.emit({ type: 'tool-update', callId, status: 'cancelled' });
                            return { stopReason: 'cancelled' };
                        }
                    }
                    const status: ToolStatus = t.status ?? 'completed';
                    driver.emit({
                        type: 'tool-update',
                        callId,
                        status,
                        ...(t.output !== undefined ? { output: t.output } : {}),
                        ...(t.error !== undefined ? { error: t.error } : {}),
                        ...(t.content !== undefined ? { content: t.content } : {})
                    });
                } else if ('agent' in step) {
                    const early = await spawn(step.agent, frame);
                    if (early) return early;
                } else if ('request' in step) {
                    const resolved = await ctx.resolve({
                        kind: 'input',
                        source: 'native',
                        ...(step.request.message !== undefined ? { message: step.request.message } : {}),
                        ...(step.request.options !== undefined ? { options: step.request.options } : {}),
                        ...(step.request.schema !== undefined ? { schema: step.request.schema } : {})
                    });
                    if (resolved.decision.type === 'cancel') return { stopReason: 'cancelled' };
                    if (resolved.decision.type === 'input') answers.push(resolved.decision.answers);
                } else if ('ext' in step) {
                    driver.emit({ type: 'ext', ns: step.ext.ns, name: step.ext.name, data: step.ext.data });
                } else if ('error' in step) {
                    driver.emit({ type: 'error', code: step.error.code, message: step.error.message, recoverable: step.error.recoverable ?? false });
                    return { stopReason: 'error', error: { code: step.error.code, message: step.error.message } };
                } else if ('output' in step) {
                    // A sub-agent's result needs no capability: it never reaches `turn-end`.
                    if (caps.structuredOutput || frame.nested) acc.output = step.output;
                } else if ('usage' in step) {
                    acc.usage = step.usage;
                    acc.costUsd = step.costUsd;
                    // Nested usage is the sub-agent's own: it lands on its `agent-update`, never on the session's totals.
                    if (!frame.nested) driver.emit({ type: 'usage', scope: 'turn', usage: step.usage, ...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}) });
                } else if ('config' in step) {
                    if (caps.config) {
                        config = [...step.config];
                        driver.emit({ type: 'config', options: config });
                    }
                } else if ('stop' in step) {
                    acc.stop = step.stop;
                }
            }
            if (frame.drain) {
                const early = await frame.drain(frame);
                if (early) return early;
            }
            return {
                stopReason: acc.stop,
                ...(acc.usage !== undefined ? { usage: acc.usage } : {}),
                ...(acc.costUsd !== undefined ? { costUsd: acc.costUsd } : {}),
                ...(acc.output !== undefined ? { output: acc.output } : {})
            };
        }

        /** An `agent` step: the spawning call, the sub-agent's lifecycle around its nested script. Returns an outcome only when the TURN must end. */
        async function spawn(a: MockAgentStep, frame: Frame): Promise<TurnEndInit | undefined> {
            const { driver, ctx } = frame;
            const callId = `call_${++callSeq}`;
            driver.emit({ type: 'tool-call', callId, name: a.name, messageId: frame.messageId, ...(a.input !== undefined ? { input: a.input } : {}), ...(a.title !== undefined ? { title: a.title } : {}) });
            driver.emit({ type: 'tool-update', callId, status: 'pending' });
            const verdict = await gate(frame, callId, a);
            if (verdict === 'cancel') return { stopReason: 'cancelled' };
            if (verdict === 'deny') return undefined;
            const terminal = (status: ToolStatus, output: unknown, error: string | undefined) =>
                driver.emit({ type: 'tool-update', callId, status, ...(output !== undefined ? { output } : {}), ...(error !== undefined ? { error } : {}) });
            if (caps.subagents === 'none') {
                // A harness that hides its sub-agents: the call runs, nothing nested shows.
                driver.emit({ type: 'tool-update', callId, status: 'in_progress' });
                terminal(a.status ?? 'completed', a.output, a.error);
                return undefined;
            }
            const agentId = `agent_${++agentSeq}`;
            // Announced inside its own call — the one place a spawn is nested.
            driver.emit({ type: 'agent-start', agentId, callId, kind: a.kind ?? a.name, title: a.title ?? a.name, parentCallId: callId });
            driver.emit({ type: 'tool-update', callId, status: 'in_progress' });
            driver.emit({ type: 'agent-update', agentId, status: 'running' });
            const abort = new AbortController();
            agentAborts.set(agentId, abort);
            const nested: Frame = {
                driver: nestedDriver(driver, callId, anySignal([driver.signal, abort.signal]).signal),
                // The innermost frame names the request's call; outer wrappers keep it.
                ctx: { options: ctx.options, onSteer: () => {}, resolve: (request, extra) => ctx.resolve(request, { parentCallId: callId, ...extra }) },
                acc: { stop: 'end_turn' },
                nested: true,
                messageId: `a:${driver.turnId}:${callId}:0`,
                partSeq: 0
            };
            let outcome: TurnEndInit;
            try {
                outcome = await play(a.steps, nested);
            } catch (e) {
                if (!isAbort(e)) throw e;
                outcome = { stopReason: 'cancelled' };
            } finally {
                agentAborts.delete(agentId);
            }
            if (outcome.stopReason === 'cancelled') {
                driver.emit({ type: 'agent-update', agentId, status: 'cancelled' });
                terminal('cancelled', undefined, undefined);
                // The whole turn was cancelled, or just this agent.
                return driver.signal.aborted ? { stopReason: 'cancelled' } : undefined;
            }
            if (outcome.stopReason === 'error') {
                const error: ErrorInfo = outcome.error ?? { code: 'provider_error', message: `sub-agent "${a.name}" failed` };
                driver.emit({ type: 'agent-update', agentId, status: 'failed', error });
                terminal('failed', undefined, error.message);
                return undefined;
            }
            const status = a.status ?? 'completed';
            const output = a.output !== undefined ? a.output : outcome.output;
            const error: ErrorInfo | undefined = a.error !== undefined ? { code: 'provider_error', message: a.error } : undefined;
            driver.emit({
                type: 'agent-update',
                agentId,
                status,
                ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
                ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
                ...(output !== undefined ? { output } : {}),
                ...(error !== undefined ? { error } : {})
            });
            terminal(status, output, a.error);
            return undefined;
        }

        const session: AgentSession = {
            id: sessionId,
            get ref() {
                return ref();
            },
            prompt(input, promptOptions) {
                // A steer (or a refused prompt) consumes no script turn.
                if (core.closed || (core.current && !core.current.settled)) return core.startTurn(input, promptOptions, async () => {});
                const turn = turnIndex++;
                return core.startTurn(input, promptOptions, async (driver, ctx) => {
                    const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : [...input];
                    driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                    const respondCtx: MockRespondContext = { answers, session, options: sessionOptions };
                    // Steering: the input lands in the transcript at once; its reply plays before the next step.
                    const steers: (readonly PromptPart[])[] = [];
                    let userSeq = 0;
                    let messageSeq = 0;
                    ctx.onSteer((steerParts) => {
                        driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}:${++userSeq}`, parts: [...steerParts] });
                        steers.push(steerParts);
                    });
                    const drain = async (frame: Frame): Promise<TurnEndInit | undefined> => {
                        while (steers.length) {
                            const steerParts = steers.shift()!;
                            const reply = options.steer ? await options.steer(steerParts, turn, respondCtx) : [{ text: 'Steered.' }];
                            // A new assistant message answers it, and the turn's own steps continue in that message.
                            const replyFrame: Frame = { driver, ctx, acc: frame.acc, nested: false, messageId: `a:${driver.turnId}:${++messageSeq}`, partSeq: 0 };
                            const outcome = await play(reply, replyFrame);
                            frame.messageId = replyFrame.messageId;
                            frame.partSeq = replyFrame.partSeq;
                            if (outcome.stopReason !== 'end_turn') return outcome;
                        }
                        return undefined;
                    };
                    const steps = options.respond ? await options.respond(parts, turn, respondCtx) : (options.script?.[turn] ?? [{ text: `Mock reply ${turn + 1}.` }]);
                    const outcome = await play(steps, { driver, ctx, acc: { stop: 'end_turn' }, nested: false, messageId: `a:${driver.turnId}:0`, partSeq: 0, drain });
                    driver.end(outcome);
                });
            },
            respond: (requestId, decision) => core.respond(requestId, decision),
            // Without the capability a cancel is a no-op, like a late respond — never an error.
            cancel: caps.cancel ? (target) => core.cancel(target) : async () => {},
            ...(caps.config
                ? {
                      configure: async (patch: Readonly<Record<string, string>>) => {
                          config = config.map((o) => (patch[o.id] !== undefined ? { ...o, current: patch[o.id]! } : o));
                          core.emit({ type: 'config', options: config });
                      }
                  }
                : {}),
            subscribe: (from) => core.subscribe(from),
            close: () => core.close()
        };
        sessions.push(session);
        return session;
    }

    return {
        id,
        capabilities: caps,
        sessions,
        session: openSession,
        // Every session this instance opened, by its current ref (the mock has no store to list from).
        ...(caps.listSessions ? { listSessions: async (): Promise<SessionSummary[]> => sessions.map((s) => ({ ref: s.ref })) } : {}),
        async dispose() {
            await Promise.all(sessions.map((s) => s.close()));
        }
    };
}

/** The driver a sub-agent's script plays through: every event nests under the spawning call, and its own abort joins the turn's. */
function nestedDriver(outer: TurnDriver, callId: string, signal: AbortSignal): TurnDriver {
    return {
        turnId: outer.turnId,
        signal,
        get ended() {
            return outer.ended;
        },
        emit: (event) => outer.emit(event.parentCallId === undefined ? { ...event, parentCallId: callId } : event),
        end: (init) => outer.end(init)
    };
}

/** Split on word boundaries (keeping trailing whitespace) or into fixed-size pieces. */
function chunk(text: string, size: number | undefined): string[] {
    if (!text) return [];
    if (size && size > 0) {
        const out: string[] = [];
        for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
        return out;
    }
    return text.match(/\S*\s|\S+$/g) ?? [text];
}
