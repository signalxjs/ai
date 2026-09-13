/**
 * The transcript — what a session looks like after its events have been
 * folded: messages with parts, open requests, session grants, usage totals,
 * the current config and state, and the last `(epoch, seq)` applied.
 *
 * Plain JSON, clock-free and id-free (every id comes from an event), so the
 * same events always produce the same transcript — the property replay,
 * persistence and late joiners rely on.
 */

import type { Usage } from '@sigx/ai';
import type {
    AgentErrorCode,
    ConfigOption,
    ContentBlock,
    ErrorInfo,
    FilePart,
    ImagePart,
    RequestKind,
    RequestOption,
    ResourcePart,
    SessionState,
    StopReason,
    ToolAnnotations,
    ToolStatus
} from '../protocol/index.js';
import type { JsonSchema } from '@sigx/ai';

export interface TextPartState {
    readonly type: 'text';
    /** Assistant parts carry the part id; user text parts have none. */
    readonly id?: string;
    text: string;
}

export interface ReasoningPartState {
    readonly type: 'reasoning';
    readonly id: string;
    text: string;
    providerData?: unknown;
}

export interface ToolPartState {
    readonly type: 'tool';
    readonly callId: string;
    readonly name: string;
    input?: unknown;
    title?: string;
    annotations?: ToolAnnotations;
    category?: string;
    status: ToolStatus;
    output?: unknown;
    error?: string;
    content?: readonly ContentBlock[];
    /** The open permission request for this call, while there is one. */
    requestId?: string;
}

/** User-message parts keep their prompt shape; assistant parts carry ids and state. */
export type AgentPart = TextPartState | ReasoningPartState | ToolPartState | ImagePart | FilePart | ResourcePart;

export interface AgentMessage {
    readonly id: string;
    readonly role: 'user' | 'assistant';
    readonly turnId?: string;
    readonly actor?: string;
    /** Set on messages produced inside a tool call (a subagent's output). */
    readonly parentCallId?: string;
    readonly author?: string;
    parts: AgentPart[];
}

export interface OpenRequest {
    readonly requestId: string;
    readonly kind: RequestKind;
    readonly turnId?: string;
    readonly callId?: string;
    readonly toolName?: string;
    readonly message?: string;
    readonly options?: readonly RequestOption[];
    readonly schema?: JsonSchema;
    readonly permissionKey?: string;
    /** The `seq` of the `request` event — what a UI orders open requests by. */
    readonly seq: number;
}

export interface TurnState {
    readonly turnId: string;
    /** Set once the turn ended. */
    stopReason?: StopReason;
    usage?: Usage;
    costUsd?: number;
    output?: unknown;
    error?: ErrorInfo;
}

export interface TranscriptError extends ErrorInfo {
    readonly code: AgentErrorCode;
    readonly recoverable: boolean;
}

export interface AgentTranscript {
    readonly sessionId: string;
    epoch: number;
    seq: number;
    state: SessionState;
    config: ConfigOption[];
    messages: AgentMessage[];
    /** Unresolved requests by id. */
    requests: Record<string, OpenRequest>;
    /** Session-scoped permission grants (`permissionKey`s). */
    grants: string[];
    /** Session totals — `session`-scoped `usage` events replace, `turn`-scoped ones add. */
    usage?: Usage;
    costUsd?: number;
    /** The running or most recent turn. */
    turn?: TurnState;
    /** The most recent `error` event. */
    error?: TranscriptError;
    /** Per-namespace extension state (`createReducer({ extensions })`). */
    ext: Record<string, unknown>;
}

export function createTranscript(sessionId: string): AgentTranscript {
    return { sessionId, epoch: 0, seq: 0, state: 'idle', config: [], messages: [], requests: {}, grants: [], ext: {} };
}
