/**
 * @sigx/ai-agent — one provider-neutral contract for agent harnesses and our
 * own engine.
 *
 * The protocol (events, capabilities, requests), the policy engine, and the
 * session helpers every adapter reuses. Edge-safe: no `node:`, no `process`,
 * no `Buffer` — Node, Bun, Deno, workerd and browsers alike. Zero runtime
 * dependencies.
 */

// Protocol
export type {
    TextPart,
    ImagePart,
    FilePart,
    ResourcePart,
    PromptPart,
    PromptInput,
    ContentBlock,
    RequestKind,
    ToolAnnotations,
    RequestOption,
    Decision,
    ConfigValue,
    ConfigOption,
    RequestInfo,
    AgentCapabilities,
    AgentErrorCode,
    StopReason,
    ToolStatus,
    AgentStatus,
    SessionState,
    ResolvedBy,
    RequestOutcome,
    ErrorInfo,
    AgentEventPayload,
    AgentEventType,
    EventContext,
    EventStamp,
    UnstampedEvent,
    AgentEvent,
    EventOf
} from './protocol/index.js';
export { toPromptParts, partsText, NO_CAPABILITIES, capabilities, AgentError, SessionBusyError, isAgentEvent, isTurnEvent } from './protocol/index.js';

// Policy
export type { SessionGrants, PolicyRequest, PolicyContext, PolicyResult, Policy, ResolveContext, Resolved } from './policy/index.js';
export { createGrants, resolveRequest, rule, allowAll, denyAll, allowReadOnly, allowTools, denyTools, firstMatch } from './policy/index.js';

// Sessions
export type {
    SessionRef,
    SessionSummary,
    AgentDefinition,
    SessionOptions,
    OutputSpec,
    PromptOptions,
    TurnResult,
    AgentTurn,
    EventCursor,
    CancelTarget,
    AgentSession,
    Agent,
    SessionLog,
    EventLogOptions,
    TurnEndInit,
    TurnDriver,
    CreateTurnOptions,
    ManagedTurn,
    SessionCoreOptions,
    TurnContext,
    AttachedSession,
    SessionCore
} from './session/index.js';
export { createEventLog, createTurn, failedTurn, createSessionCore } from './session/index.js';

// State
export type { TextPartState, ReasoningPartState, ToolPartState, AgentPart, AgentMessage, OpenRequest, TurnState, TranscriptError, AgentState, AgentNode, AgentTranscript, ReducerExtension, AgentReducer, CreateReducerOptions, ToUIOptions, FromUIOptions, Imported } from './state/index.js';
export { createTranscript, createReducer, reduceAgentEvent, spawnedAgent, callerAgent, childAgents, agentMessages, agentTree, walkAgents, agentsUsage, toUIMessages, promptPartsToUI, toolState, toolOutput, contentToOutput, fromUIMessages, toChatStream, toFinishReason } from './state/index.js';

// Stores
export type { TranscriptStore, EventLogStore } from './store/index.js';
export { memoryTranscriptStore, memoryEventLog } from './store/index.js';

// Our engine as an agent, and an agent as a tool
export type { ModelAgentOptions, ModelAgentRefData, AgentToolContext } from './model-agent/index.js';
export { modelAgent, MODEL_AGENT_CAPABILITIES } from './model-agent/index.js';
export type { AgentToolOptions, AgentToolResult } from './agent-tool/index.js';
export { agentTool } from './agent-tool/index.js';
