/**
 * `mockAgent` — a scripted, deterministic `Agent` for tests, docs and CI.
 *
 * Each turn plays a list of steps: text (streamed in chunks), tool calls
 * (through the policy, like a real harness), input requests, extension
 * events, errors, structured output. Capabilities are honest: a step the
 * declared capabilities do not cover is skipped, so a reduced mock behaves
 * like a reduced harness.
 */

import type { JsonSchema, Usage } from '@sigx/ai';
import type {
    AgentCapabilities,
    AgentErrorCode,
    ConfigOption,
    ContentBlock,
    PromptPart,
    RequestOption,
    StopReason,
    ToolAnnotations,
    ToolStatus
} from '../protocol/index.js';
import { AgentError, capabilities as makeCapabilities } from '../protocol/index.js';
import type { Agent, AgentSession, SessionOptions, SessionRef } from '../session/index.js';
import { createEventLog, createSessionCore } from '../session/index.js';
import type { TurnDriver, TurnContext } from '../session/index.js';
import { sleep } from '../utils/abort.js';
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
}

export interface MockAgent extends Agent {
    /** Every session opened, in order. */
    readonly sessions: readonly AgentSession[];
}

/** The mock's default: everything an in-process agent can honour. */
export const MOCK_CAPABILITIES: AgentCapabilities = makeCapabilities({
    resume: 'portable',
    cancel: true,
    config: true,
    structuredOutput: true,
    promptParts: 'text+image+file',
    tools: 'native',
    permissions: 'every-call',
    importTranscript: true
});

interface MockRefData {
    readonly turn: number;
    readonly answers: readonly unknown[];
}

export function mockAgent(options: MockAgentOptions = {}): MockAgent {
    const id = options.id ?? 'mock';
    const caps = { ...MOCK_CAPABILITIES, ...options.capabilities };
    const sessions: AgentSession[] = [];
    let callSeq = 0;

    async function openSession(sessionOptions: SessionOptions = {}): Promise<AgentSession> {
        let turnIndex = 0;
        const answers: unknown[] = [];
        let sessionId = generateId('sess');
        let epoch = 1;
        if (sessionOptions.resume) {
            if (!caps.resume) throw new AgentError('protocol_error', `[sigx ai-agent] agent "${id}" cannot resume sessions`);
            if (sessionOptions.resume.agent !== id) throw new AgentError('protocol_error', `[sigx ai-agent] session ref belongs to agent "${sessionOptions.resume.agent}", not "${id}"`);
            const data = (sessionOptions.resume.data ?? {}) as Partial<MockRefData> & { epoch?: number };
            turnIndex = data.turn ?? 0;
            answers.push(...(data.answers ?? []));
            if (sessionOptions.fork) {
                if (!caps.fork) throw new AgentError('protocol_error', `[sigx ai-agent] agent "${id}" cannot fork sessions`);
            } else {
                sessionId = sessionOptions.resume.id;
                epoch = (data.epoch ?? 1) + 1;
            }
        }
        const log = createEventLog({ sessionId, epoch });
        const core = createSessionCore({
            id: sessionId,
            log,
            ...(sessionOptions.policy ? { policy: sessionOptions.policy } : {}),
            interactive: sessionOptions.interactive ?? true,
            ...(sessionOptions.requestTimeoutMs !== undefined ? { requestTimeoutMs: sessionOptions.requestTimeoutMs } : {}),
            ...(sessionOptions.signal ? { signal: sessionOptions.signal } : {}),
            steer: caps.steer
        });
        let config: ConfigOption[] = [];

        const ref = (): SessionRef => ({ agent: id, v: 1, id: sessionId, data: { turn: turnIndex, answers: [...answers], epoch: log.epoch } satisfies MockRefData & { epoch: number } });

        async function play(steps: readonly MockStep[], driver: TurnDriver, ctx: TurnContext): Promise<void> {
            let partSeq = 0;
            let usage: Usage | undefined;
            let costUsd: number | undefined;
            let output: unknown;
            let stop: StopReason = 'end_turn';
            const messageId = `a:${driver.turnId}:0`;

            const stream = async (kind: 'text' | 'reasoning', text: string, actor: string | undefined, chunkSize: number | undefined, delayMs: number) => {
                const partId = `${messageId}:${partSeq++}`;
                driver.emit({ type: 'part-start', messageId, partId, kind, ...(actor !== undefined ? { actor } : {}) });
                for (const delta of chunk(text, chunkSize)) {
                    if (driver.signal.aborted) return;
                    if (delayMs > 0) await sleep(delayMs, driver.signal);
                    driver.emit({ type: 'part-delta', partId, delta });
                }
                driver.emit({ type: 'part-end', partId });
            };

            for (const step of steps) {
                if (driver.signal.aborted) return;
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
                        messageId,
                        ...(t.input !== undefined ? { input: t.input } : {}),
                        ...(t.title !== undefined ? { title: t.title } : {}),
                        ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
                        ...(t.category !== undefined ? { category: t.category } : {})
                    });
                    driver.emit({ type: 'tool-update', callId, status: 'pending' });
                    if (caps.permissions !== 'none') {
                        const resolved = await ctx.resolve({
                            kind: 'permission',
                            callId,
                            toolName: t.name,
                            ...(t.input !== undefined ? { input: t.input } : {}),
                            ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
                            ...(t.category !== undefined ? { category: t.category } : {}),
                            source: t.source ?? 'native',
                            permissionKey: t.permissionKey ?? `tool:${t.name}`
                        });
                        const d = resolved.decision;
                        if (d.type === 'cancel') {
                            driver.emit({ type: 'tool-update', callId, status: 'cancelled' });
                            driver.end({ stopReason: 'cancelled' });
                            return;
                        }
                        if (d.type === 'permission' && d.outcome === 'deny') {
                            driver.emit({ type: 'tool-update', callId, status: 'denied', ...(d.message !== undefined ? { error: d.message } : {}) });
                            continue;
                        }
                    }
                    driver.emit({ type: 'tool-update', callId, status: 'in_progress' });
                    if (t.delayMs) {
                        try {
                            await sleep(t.delayMs, driver.signal);
                        } catch {
                            driver.emit({ type: 'tool-update', callId, status: 'cancelled' });
                            return;
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
                } else if ('request' in step) {
                    const resolved = await ctx.resolve({
                        kind: 'input',
                        source: 'native',
                        ...(step.request.message !== undefined ? { message: step.request.message } : {}),
                        ...(step.request.options !== undefined ? { options: step.request.options } : {}),
                        ...(step.request.schema !== undefined ? { schema: step.request.schema } : {})
                    });
                    if (resolved.decision.type === 'cancel') {
                        driver.end({ stopReason: 'cancelled' });
                        return;
                    }
                    if (resolved.decision.type === 'input') answers.push(resolved.decision.answers);
                } else if ('ext' in step) {
                    driver.emit({ type: 'ext', ns: step.ext.ns, name: step.ext.name, data: step.ext.data });
                } else if ('error' in step) {
                    driver.emit({ type: 'error', code: step.error.code, message: step.error.message, recoverable: step.error.recoverable ?? false });
                    driver.end({ stopReason: 'error', error: { code: step.error.code, message: step.error.message } });
                    return;
                } else if ('output' in step) {
                    if (caps.structuredOutput) output = step.output;
                } else if ('usage' in step) {
                    usage = step.usage;
                    costUsd = step.costUsd;
                    driver.emit({ type: 'usage', scope: 'turn', usage: step.usage, ...(step.costUsd !== undefined ? { costUsd: step.costUsd } : {}) });
                } else if ('config' in step) {
                    if (caps.config) {
                        config = [...step.config];
                        driver.emit({ type: 'config', options: config });
                    }
                } else if ('stop' in step) {
                    stop = step.stop;
                }
            }
            driver.end({
                stopReason: stop,
                ...(usage !== undefined ? { usage } : {}),
                ...(costUsd !== undefined ? { costUsd } : {}),
                ...(output !== undefined ? { output } : {})
            });
        }

        const session: AgentSession = {
            id: sessionId,
            get ref() {
                return ref();
            },
            prompt(input, promptOptions) {
                const turn = turnIndex++;
                return core.startTurn(input, promptOptions, async (driver, ctx) => {
                    const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : [...input];
                    driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                    const steps = options.respond
                        ? await options.respond(parts, turn, { answers, session, options: sessionOptions })
                        : (options.script?.[turn] ?? [{ text: `Mock reply ${turn + 1}.` }]);
                    await play(steps, driver, ctx);
                });
            },
            respond: (requestId, decision) => core.respond(requestId, decision),
            cancel: () => core.cancel(),
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
        async dispose() {
            await Promise.all(sessions.map((s) => s.close()));
        }
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
