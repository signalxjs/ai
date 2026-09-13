/**
 * `modelAgent` — our own engine as an `Agent`.
 *
 * Every app written against the contract runs on `@sigx/ai-anthropic`,
 * `@sigx/ai-openai` or any `LanguageModel`, on the edge, with no process:
 * each prompt is one `streamText` turn over the session transcript, chunks
 * become events, tool calls go through the policy, and the transcript is
 * the resumable state (`SessionRef` names it in a `TranscriptStore`, or
 * carries it when there is none).
 */

import { streamText, toModelMessages, type AnyTool, type JsonSchema, type LanguageModel, type ModelUserMessage, type StandardSchemaV1, type UIMessage, type Usage } from '@sigx/ai';
import type { AgentCapabilities, PromptInput } from '../protocol/index.js';
import { AgentError, capabilities } from '../protocol/index.js';
import { createGrants } from '../policy/index.js';
import type { Agent, AgentSession, OutputSpec, PromptOptions, SessionLog, SessionOptions, SessionRef } from '../session/index.js';
import { createEventLog, createSessionCore } from '../session/index.js';
import type { AgentTranscript, ReducerExtension } from '../state/index.js';
import { createReducer, createTranscript, fromUIMessages, promptPartsToUI, toUIMessages } from '../state/index.js';
import type { TranscriptStore } from '../store/index.js';
import { generateId } from '../utils/id.js';
import { gateTools } from './gate-tools.js';
import { createChunkMapper } from './map-chunks.js';

export interface ModelAgentOptions {
    readonly model: LanguageModel;
    readonly system?: string;
    /** Tools every session gets; a session's own `tools` are added. */
    readonly tools?: readonly AnyTool[];
    /** Model rounds per turn (`streamText`'s `maxSteps`). Default 5. */
    readonly maxSteps?: number;
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly providerOptions?: Readonly<Record<string, unknown>>;
    /** Where transcripts live; without one the `SessionRef` carries the transcript. */
    readonly store?: TranscriptStore;
    /** Reducer plugins for the session transcript (e.g. `codingExtension()`). */
    readonly extensions?: readonly ReducerExtension[];
    /**
     * A turn's cost in USD from its usage — the `LanguageModel` seam carries no
     * price list, so the app is the honest source. Without it no `costUsd` is
     * reported.
     */
    readonly pricing?: (usage: Usage) => number | undefined;
    /** Default `'sigx'`. */
    readonly id?: string;
}

/** What `SessionRef.data` carries when there is no store — or what `importTranscript` accepts. */
export interface ModelAgentRefData {
    readonly transcript?: AgentTranscript;
    /** A portable `@sigx/ai` transcript to import (`fromUIMessages`). */
    readonly messages?: readonly UIMessage[];
}

export const MODEL_AGENT_CAPABILITIES: AgentCapabilities = capabilities({
    resume: 'portable',
    fork: true,
    cancel: true,
    // A prompt during a turn is injected between model rounds (`streamText`'s `steer`).
    steer: true,
    structuredOutput: true,
    promptParts: 'text+image+file',
    tools: 'native',
    permissions: 'every-call',
    importTranscript: true,
    // Delegates opened by `agentTool` are attached to the session: `respond()`
    // reaches their requests and `cancel({ agentId })` stops one of them.
    subagents: 'control'
});

const passthrough: StandardSchemaV1<unknown, unknown> = { '~standard': { version: 1, vendor: 'sigx-ai-agent', validate: (value) => ({ value }) } };

/** The engine wants a Standard Schema; a plain JSON Schema rides along as `jsonSchema`. */
function toEngineOutput(spec: OutputSpec | undefined): { schema: StandardSchemaV1; jsonSchema?: JsonSchema; name?: string } | undefined {
    if (!spec) return undefined;
    const schema = spec.schema;
    if ('~standard' in schema) return { schema: schema as StandardSchemaV1, ...(spec.name !== undefined ? { name: spec.name } : {}) };
    return { schema: passthrough, jsonSchema: schema as JsonSchema, ...(spec.name !== undefined ? { name: spec.name } : {}) };
}

/**
 * A fork is a NEW session over a copy of the conversation: it gets its own id,
 * starts at epoch 0, and carries no open requests and no session grants (a
 * grant is scoped to the session that gave it).
 */
function forkTranscript(source: AgentTranscript, sessionId: string): AgentTranscript {
    const { turn: _turn, error: _error, ...rest } = structuredClone(source);
    return { ...rest, sessionId, epoch: 0, seq: 0, state: 'idle', requests: {}, grants: [] };
}

/** A log whose every stamped event is also reduced into `transcript`, synchronously. */
function reducingLog(log: SessionLog, transcript: AgentTranscript, reduce: ReturnType<typeof createReducer>): SessionLog {
    return {
        sessionId: log.sessionId,
        get epoch() {
            return log.epoch;
        },
        get seq() {
            return log.seq;
        },
        get closed() {
            return log.closed;
        },
        append: (event) => {
            const stamped = log.append(event);
            reduce(transcript, stamped);
            return stamped;
        },
        subscribe: (from) => log.subscribe(from),
        bumpEpoch: () => log.bumpEpoch(),
        close: () => log.close()
    };
}

export function modelAgent(options: ModelAgentOptions): Agent {
    const id = options.id ?? 'sigx';
    const sessions = new Set<AgentSession>();

    async function openSession(sessionOptions: SessionOptions = {}): Promise<AgentSession> {
        const reduce = createReducer(options.extensions ? { extensions: options.extensions } : {});
        let sessionId = generateId('sess');
        let transcript: AgentTranscript | undefined;
        const resume = sessionOptions.resume;
        if (resume) {
            if (resume.agent !== id) throw new AgentError('protocol_error', `[sigx ai-agent] session ref belongs to agent "${resume.agent}", not "${id}"`);
            const data = (resume.data ?? {}) as ModelAgentRefData;
            const loaded = (await options.store?.load(resume.id)) ?? data.transcript ?? (data.messages ? fromUIMessages(data.messages, { sessionId: resume.id, reducer: reduce }).transcript : undefined);
            if (!loaded) throw new AgentError('protocol_error', `[sigx ai-agent] nothing to resume for session "${resume.id}": no stored transcript and none in the ref`);
            if (sessionOptions.fork) transcript = forkTranscript(loaded, sessionId);
            else {
                sessionId = resume.id;
                transcript = loaded;
            }
        }
        transcript ??= createTranscript(sessionId);
        const rawLog = createEventLog({ sessionId, epoch: transcript.epoch + 1 });
        const log = reducingLog(rawLog, transcript, reduce);
        const core = createSessionCore({
            id: sessionId,
            log,
            // Session grants are part of the transcript, so a resumed session is not asked again.
            grants: createGrants(transcript.grants),
            ...(sessionOptions.policy ? { policy: sessionOptions.policy } : {}),
            interactive: sessionOptions.interactive ?? true,
            ...(sessionOptions.requestTimeoutMs !== undefined ? { requestTimeoutMs: sessionOptions.requestTimeoutMs } : {}),
            ...(sessionOptions.signal ? { signal: sessionOptions.signal } : {}),
            steer: MODEL_AGENT_CAPABILITIES.steer,
            subagents: MODEL_AGENT_CAPABILITIES.subagents,
            promptParts: MODEL_AGENT_CAPABILITIES.promptParts
        });
        const tools: AnyTool[] = [...(options.tools ?? []), ...(sessionOptions.tools ?? [])];
        const system = sessionOptions.system ?? options.system;

        const persist = async () => {
            await options.store?.save(sessionId, transcript!);
        };

        const session: AgentSession = {
            id: sessionId,
            get ref(): SessionRef {
                return { agent: id, v: 1, id: sessionId, ...(options.store ? {} : { data: { transcript: structuredClone(transcript) } satisfies ModelAgentRefData }) };
            },
            prompt(input: PromptInput, promptOptions?: PromptOptions) {
                return core.startTurn(input, promptOptions, async (driver, ctx) => {
                    const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : [...input];
                    driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}`, parts });
                    const messageId = `a:${driver.turnId}:0`;
                    const gated = gateTools(tools, { driver, resolve: (request) => ctx.resolve(request), attach: (downstream) => core.attach(downstream) });
                    const mapper = createChunkMapper(driver, { messageId, tools, ...(options.pricing ? { pricing: options.pricing } : {}) });
                    const output = toEngineOutput(promptOptions?.output);
                    // Steering: the input goes into the transcript at once (a
                    // `user-message` in this turn) and waits for the engine's next
                    // round boundary. What the engine never drains — a steer
                    // after its last round — stays in the transcript and feeds
                    // the next turn's conversation.
                    const steers: ModelUserMessage[] = [];
                    let steerSeq = 0;
                    ctx.onSteer((steerParts) => {
                        driver.emit({ type: 'user-message', messageId: `u:${driver.turnId}:${++steerSeq}`, parts: steerParts });
                        const [message] = toModelMessages([{ id: 'steer', role: 'user', parts: promptPartsToUI(steerParts) }]);
                        if (message?.role === 'user') steers.push(message);
                    });
                    try {
                        for await (const chunk of streamText({
                            model: options.model,
                            ...(system !== undefined ? { system } : {}),
                            // `omit`: a delegate's words are its own, never the host model's.
                            messages: toModelMessages(toUIMessages(transcript!, { subagents: 'omit' })),
                            steer: () => {
                                const taken = steers.splice(0);
                                // The reply to steering input is a message of its own.
                                if (taken.length) mapper.nextMessage();
                                return taken;
                            },
                            ...(gated.tools.length ? { tools: gated.tools, onToolApproval: gated.onToolApproval } : {}),
                            ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
                            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
                            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                            ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
                            ...(output ? { output } : {}),
                            signal: driver.signal,
                            messageId
                        })) {
                            mapper.apply(chunk);
                            if (driver.ended) break;
                        }
                    } finally {
                        await persist();
                    }
                });
            },
            respond: (requestId, decision) => core.respond(requestId, decision),
            cancel: (target) => core.cancel(target),
            subscribe: (from) => core.subscribe(from),
            async close() {
                await core.close();
                await persist();
                sessions.delete(session);
            }
        };
        sessions.add(session);
        return session;
    }

    return {
        id,
        capabilities: MODEL_AGENT_CAPABILITIES,
        session: openSession,
        async dispose() {
            await Promise.all([...sessions].map((s) => s.close()));
        }
    };
}
