/**
 * The event union — the one wire every agent speaks.
 *
 * Every event carries its `sessionId`, an `epoch` (bumped on resume) and a
 * `seq` that is gapless and monotonic within the epoch, so any consumer can
 * replay from `(epoch, seq)` and reach the same state. Events are plain
 * JSON: no `Date`, no `undefined` inside arrays; vendor detail travels as
 * JSON under `error.data` / `ext.data`, never as a native payload.
 *
 * Domain-neutral by design: a tool is a name, an input and a status; what it
 * touched is an `ext` event in a namespace (`coding.diff`, `agent.handoff`).
 *
 * Sub-agents: a spawn is always a call. `agent-start` binds an `agentId` to
 * the `tool-call` that spawned it, and every event produced inside the
 * sub-agent carries that call as `parentCallId`. An `agent-start` emitted
 * inside the spawning call therefore carries `parentCallId === callId`.
 */

import type { Usage } from '@sigx/ai';
import type { ContentBlock, PromptPart } from './content.js';
import type { AgentErrorCode } from './errors.js';
import type { ConfigOption, RequestKind, RequestOption, ToolAnnotations } from './request.js';
import type { JsonSchema } from '@sigx/ai';

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turns' | 'refusal' | 'cancelled' | 'error';
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'denied';
/** A sub-agent's lifecycle; `completed`, `failed` and `cancelled` are terminal. */
export type AgentStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type SessionState = 'idle' | 'running' | 'awaiting' | 'closed' | 'error';
/** Who settled a request. */
export type ResolvedBy = 'policy' | 'client' | 'timeout' | 'cancel';
export type RequestOutcome = 'allow' | 'deny' | 'input' | 'cancel';

export interface ErrorInfo {
    readonly code: AgentErrorCode;
    readonly message: string;
}

export type AgentEventPayload =
    | { readonly type: 'turn-start'; readonly input: readonly PromptPart[] }
    | {
          readonly type: 'turn-end';
          readonly stopReason: StopReason;
          readonly usage?: Usage;
          readonly costUsd?: number;
          /** The structured result when the prompt asked for one. */
          readonly output?: unknown;
          readonly error?: ErrorInfo;
      }
    | { readonly type: 'user-message'; readonly messageId: string; readonly parts: readonly PromptPart[]; readonly author?: string }
    | {
          readonly type: 'part-start';
          readonly messageId: string;
          readonly partId: string;
          readonly kind: 'text' | 'reasoning';
          /** Who is speaking when not the main assistant (a subagent, a handoff target). */
          readonly actor?: string;
      }
    | { readonly type: 'part-delta'; readonly partId: string; readonly delta: string }
    | { readonly type: 'part-end'; readonly partId: string; readonly providerData?: unknown }
    | {
          readonly type: 'tool-call';
          readonly callId: string;
          readonly name: string;
          /** The assistant message the call belongs to; the reducer falls back to the turn's current one. */
          readonly messageId?: string;
          readonly input?: unknown;
          readonly title?: string;
          readonly annotations?: ToolAnnotations;
          readonly category?: string;
      }
    | {
          readonly type: 'tool-update';
          readonly callId: string;
          readonly status: ToolStatus;
          readonly output?: unknown;
          readonly error?: string;
          readonly content?: readonly ContentBlock[];
      }
    | {
          readonly type: 'agent-start';
          /** The sub-agent: a harness task or thread id, or the delegate session id. Unique within the session. */
          readonly agentId: string;
          /** The `tool-call` that spawned it. Absent only for an ambient task the harness started on its own. */
          readonly callId?: string;
          /** Harness-defined: a Claude Code agent type, a Codex role, an `agentTool` name. */
          readonly kind?: string;
          readonly title?: string;
          readonly description?: string;
          readonly model?: string;
          /** The harness's own nesting depth; the reducer derives depth from `callId` when it can. */
          readonly depth?: number;
          readonly background?: boolean;
      }
    | {
          readonly type: 'agent-update';
          readonly agentId: string;
          readonly status: AgentStatus;
          readonly summary?: string;
          /** Cumulative for this agent — replaces, never adds. */
          readonly usage?: Usage;
          readonly costUsd?: number;
          readonly output?: unknown;
          readonly error?: ErrorInfo;
      }
    | {
          readonly type: 'request';
          readonly requestId: string;
          readonly kind: RequestKind;
          readonly callId?: string;
          readonly toolName?: string;
          readonly message?: string;
          readonly options?: readonly RequestOption[];
          readonly schema?: JsonSchema;
          readonly permissionKey?: string;
      }
    | {
          readonly type: 'request-resolved';
          readonly requestId: string;
          readonly outcome: RequestOutcome;
          readonly scope?: 'once' | 'session';
          readonly answers?: unknown;
          readonly by: ResolvedBy;
          readonly reason?: string;
          readonly ruleId?: string;
          /** Repeated from the request so a session-scoped grant can be replayed without it. */
          readonly permissionKey?: string;
          /** Epoch milliseconds. */
          readonly at: number;
      }
    | { readonly type: 'config'; readonly options: readonly ConfigOption[] }
    | { readonly type: 'usage'; readonly scope: 'turn' | 'session'; readonly usage: Usage; readonly costUsd?: number }
    | { readonly type: 'state'; readonly value: SessionState }
    | { readonly type: 'error'; readonly code: AgentErrorCode; readonly message: string; readonly recoverable: boolean; readonly data?: unknown }
    | { readonly type: 'ext'; readonly ns: string; readonly name: string; readonly data: unknown };

export type AgentEventType = AgentEventPayload['type'];

/** What every event carries besides its payload. */
export interface EventContext {
    readonly turnId?: string;
    /** The `tool-call` this event happened inside (a subagent, a delegated tool). */
    readonly parentCallId?: string;
}

export interface EventStamp {
    readonly sessionId: string;
    readonly epoch: number;
    readonly seq: number;
}

/** An event as an adapter emits it — the session log stamps it. */
export type UnstampedEvent = AgentEventPayload & EventContext;

export type AgentEvent = AgentEventPayload & EventContext & EventStamp;

export type EventOf<T extends AgentEventType> = Extract<AgentEvent, { readonly type: T }>;

const EVENT_TYPES: ReadonlySet<string> = new Set<AgentEventType>([
    'turn-start',
    'turn-end',
    'user-message',
    'part-start',
    'part-delta',
    'part-end',
    'tool-call',
    'tool-update',
    'agent-start',
    'agent-update',
    'request',
    'request-resolved',
    'config',
    'usage',
    'state',
    'error',
    'ext'
]);

/** Minimal shape check — enough to route an event, never a validator. */
export function isAgentEvent(value: unknown): value is AgentEvent {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.type === 'string' && EVENT_TYPES.has(v.type) && typeof v.sessionId === 'string' && typeof v.epoch === 'number' && typeof v.seq === 'number';
}

/** The event types that belong to a turn (everything but session-level bookkeeping). */
export function isTurnEvent(event: AgentEvent, turnId: string): boolean {
    return event.turnId === turnId;
}
