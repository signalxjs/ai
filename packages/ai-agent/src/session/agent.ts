/**
 * The contract — `Agent`, `AgentSession`, `AgentTurn`.
 *
 * One `Agent` may host many sessions (one harness process, many
 * conversations). A session is a log of events plus three verbs: `prompt`,
 * `respond`, `cancel`. A turn is that log filtered by its `turnId`, driven
 * and buffered internally, so a caller that only awaits `turn.result` never
 * blocks the harness.
 */

import type { AnyTool, JsonSchema, StandardSchemaV1, Usage } from '@sigx/ai';
import type { AgentCapabilities, AgentEvent, Decision, ErrorInfo, PromptInput, StopReason } from '../protocol/index.js';
import type { Policy } from '../policy/index.js';

/** Opaque, JSON — persist it, hand it back as `resume`. */
export interface SessionRef {
    readonly agent: string;
    readonly v: number;
    readonly id: string;
    readonly data?: unknown;
}

export interface SessionSummary {
    readonly ref: SessionRef;
    readonly title?: string;
    /** Epoch milliseconds. */
    readonly updatedAt?: number;
}

/** A sub-agent the session may spawn by name (`defineAgents` capability). */
export interface AgentDefinition {
    /** When to delegate to it — what the model reads. */
    readonly description: string;
    /** The sub-agent's system prompt. */
    readonly prompt?: string;
    /** Names of the session's tools it may use; default: all. */
    readonly tools?: readonly string[];
    readonly model?: string;
    /** Model rounds per delegation (`maxSteps` on our engine, `maxTurns` on Claude Code). */
    readonly maxTurns?: number;
}

/** Adapters extend this with typed options (`cwd`, an executable path, …). */
export interface SessionOptions {
    readonly system?: string;
    readonly model?: string;
    readonly tools?: readonly AnyTool[];
    /** Sub-agents the model may spawn, keyed by name (`defineAgents` capability). */
    readonly agents?: Readonly<Record<string, AgentDefinition>>;
    readonly policy?: Policy;
    /** `false`: no human — `'ask'` falls back to deny. Default `true`. */
    readonly interactive?: boolean;
    /** How long an open `request` waits for `respond()` before it is denied. */
    readonly requestTimeoutMs?: number;
    readonly resume?: SessionRef;
    /** With `resume`: continue as a new session instead of the same one (needs the `fork` capability). */
    readonly fork?: boolean;
    readonly signal?: AbortSignal;
}

export interface OutputSpec {
    readonly schema: StandardSchemaV1 | JsonSchema;
    readonly name?: string;
}

export interface PromptOptions {
    /** Supplied by remote clients so they can correlate events before the ack; generated otherwise. */
    readonly turnId?: string;
    readonly output?: OutputSpec;
    readonly signal?: AbortSignal;
}

/** The `turn-end` event, as a value. */
export interface TurnResult {
    readonly turnId: string;
    readonly stopReason: StopReason;
    readonly usage?: Usage;
    readonly costUsd?: number;
    readonly output?: unknown;
    readonly error?: ErrorInfo;
}

export interface AgentTurn extends AsyncIterable<AgentEvent> {
    readonly id: string;
    /** Settles with the turn's end; rejects only when the turn could not start (e.g. `SessionBusyError`). */
    readonly result: Promise<TurnResult>;
}

export interface EventCursor {
    readonly epoch: number;
    readonly seq: number;
}

/** What `cancel` aims at: nothing (the running turn) or one sub-agent. */
export interface CancelTarget {
    /** A sub-agent's `agentId` (`subagents: 'control'`); the session's own id means the running turn. */
    readonly agentId?: string;
}

export interface AgentSession {
    readonly id: string;
    readonly ref: SessionRef;
    /**
     * Run a turn — or, while one runs and the agent has `steer`, inject into it:
     * the returned turn then has the RUNNING turn's `id` and `result` and
     * iterates that turn's events from the steer on (`turnId` and `output`
     * in `options` are ignored). Without `steer`, a prompt during a turn
     * rejects with `SessionBusyError`.
     */
    prompt(input: PromptInput, options?: PromptOptions): AgentTurn;
    /** Answer an open `request` — at any depth with `subagents: 'control'`; a late answer resolves without effect. */
    respond(requestId: string, decision: Decision): Promise<void>;
    /** Cancel the running turn, or one sub-agent (`subagents: 'control'`). A target that no longer runs is a no-op. */
    cancel(target?: CancelTarget): Promise<void>;
    /** Change a `config` option (`config` capability). */
    configure?(patch: Readonly<Record<string, string>>): Promise<void>;
    /** Every event from `from` (exclusive) on; without `from`, live from now. */
    subscribe(from?: EventCursor): AsyncIterable<AgentEvent>;
    close(): Promise<void>;
}

export interface Agent<O extends SessionOptions = SessionOptions> {
    /** `'sigx' | 'claude-code' | 'codex' | 'acp:gemini' | …` — for logs, never for branching. */
    readonly id: string;
    readonly capabilities: AgentCapabilities;
    session(options?: O): Promise<AgentSession>;
    listSessions?(): Promise<SessionSummary[]>;
    /** Release every session and the harness process, if any. */
    dispose(): Promise<void>;
}
