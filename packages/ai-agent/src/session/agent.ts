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

/** Adapters extend this with typed options (`cwd`, an executable path, …). */
export interface SessionOptions {
    readonly system?: string;
    readonly model?: string;
    readonly tools?: readonly AnyTool[];
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

export interface AgentSession {
    readonly id: string;
    readonly ref: SessionRef;
    prompt(input: PromptInput, options?: PromptOptions): AgentTurn;
    /** Answer an open `request`; a late answer resolves without effect. */
    respond(requestId: string, decision: Decision): Promise<void>;
    cancel(): Promise<void>;
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
