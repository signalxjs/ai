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
    AgentStatus,
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
    /**
     * Set by `part-end`. A harness may redact reasoning TEXT and still open a
     * real reasoning part (Claude Code streams empty deltas and reports
     * progress as `usage.reasoningTokens`), so empty text alone cannot tell a
     * block that is still thinking from one that thought and showed nothing —
     * a view needs both to render "thinking…" only while it is true.
     */
    done?: true;
    providerData?: unknown;
}

/**
 * A tool part's state: the wire's `ToolStatus` plus `streaming`, which only the
 * REDUCER sets — the arguments are still arriving and the call has not been
 * made. No adapter ever emits it; `tool-update.status` stays `ToolStatus`. The
 * same split `@sigx/ai` makes with `UIToolState`.
 */
export type ToolPartStatus = ToolStatus | 'streaming';

export interface ToolPartState {
    readonly type: 'tool';
    readonly callId: string;
    readonly name: string;
    /**
     * The call's arguments.
     *
     * While `status` is `streaming` this is the best partial read of
     * `inputText`, repaired structurally: `{"ci` is a dangling key and reads
     * as `{}`, `{"city":"Pa` as `{ city: 'Pa' }`. It is ABSENT when there is
     * nothing to read at all — no text yet, or arguments that are not JSON —
     * so `'input' in part` is the honest test for "an argument can be read",
     * and an early `{}` means "nothing named yet", not "called with nothing".
     * Once a `tool-call` has settled the part, this is the input the call was
     * made with, and absent if it named none.
     */
    input?: unknown;
    /**
     * The raw argument JSON as it arrives, while `status` is `streaming`, so a
     * view can show the text before it parses. Deleted when the call settles.
     */
    inputText?: string;
    title?: string;
    annotations?: ToolAnnotations;
    category?: string;
    status: ToolPartStatus;
    output?: unknown;
    error?: string;
    content?: readonly ContentBlock[];
    /** The open permission request for this call, while there is one. */
    requestId?: string;
    /** The sub-agent this call spawned, once its `agent-start` arrived. */
    agentId?: string;
}

/**
 * One sub-agent. A spawn is always a call: `callId` names the `tool-call`
 * that started the agent, and the messages produced inside it are the ones
 * whose `parentCallId` is that call. `depth` and `parentAgentId` come from
 * the call chain (the message that made the spawning call was itself inside
 * some call, or not); the harness's own `depth` counts only when the chain
 * cannot say — a call-less ambient agent, or a spawn inside a call no
 * `agent-start` claimed.
 */
export interface AgentState {
    readonly agentId: string;
    readonly callId?: string;
    readonly parentAgentId?: string;
    readonly depth: number;
    readonly turnId?: string;
    /** The `seq` of `agent-start` — the order a UI lists agents in. */
    readonly seq: number;
    kind?: string;
    title?: string;
    description?: string;
    model?: string;
    background?: boolean;
    status: AgentStatus;
    summary?: string;
    /** Cumulative for this agent — an `agent-update` replaces it. */
    usage?: Usage;
    costUsd?: number;
    output?: unknown;
    error?: ErrorInfo;
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
    /** Every sub-agent seen, by id — see `agentTree` and the other selectors. */
    agents: Record<string, AgentState>;
    /** Session totals — `session`-scoped `usage` events replace, `turn`-scoped ones add. Sub-agent usage lives on `agents`. */
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
    return { sessionId, epoch: 0, seq: 0, state: 'idle', config: [], messages: [], requests: {}, grants: [], agents: {}, ext: {} };
}
