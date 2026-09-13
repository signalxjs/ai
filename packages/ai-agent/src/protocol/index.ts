/** The protocol — events, content, requests, capabilities, errors. Types and guards only. */

export type { TextPart, ImagePart, FilePart, ResourcePart, PromptPart, PromptInput, ContentBlock } from './content.js';
export { toPromptParts, partsText } from './content.js';
export type { RequestKind, ToolAnnotations, RequestOption, Decision, ConfigValue, ConfigOption, RequestInfo } from './request.js';
export type { AgentCapabilities } from './capabilities.js';
export { NO_CAPABILITIES, capabilities } from './capabilities.js';
export type { AgentErrorCode } from './errors.js';
export { AgentError, SessionBusyError } from './errors.js';
export type {
    StopReason,
    ToolStatus,
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
} from './event.js';
export { isAgentEvent, isTurnEvent } from './event.js';
