/** @sigx/ai-agent-acp — every Agent Client Protocol agent as an `Agent`; vendors are presets. */

export type { AcpOptions, AcpPreset, AcpSessionOptions, AcpTransportStreams } from './options.js';
export type { AcpAgent } from './provider.js';
export { acp, ACP_BASE_CAPABILITIES, capabilitiesFrom } from './provider.js';
export { gemini, cursor, claudeCodeAcp, codexAcp, copilotAcp } from './presets.js';
export { ACP_PROTOCOL_VERSION, ACP_METHODS, ACP_AUTH_REQUIRED } from './schema.js';
export type {
    AcpInitializeRequest,
    AcpInitializeResponse,
    AcpAgentCapabilities,
    AcpClientCapabilities,
    AcpAuthMethod,
    AcpMcpServer,
    AcpNewSessionRequest,
    AcpNewSessionResponse,
    AcpPromptRequest,
    AcpPromptResponse,
    AcpStopReason,
    AcpUsage,
    AcpSessionNotification,
    AcpSessionUpdate,
    AcpToolCall,
    AcpToolCallUpdate,
    AcpToolCallContent,
    AcpToolKind,
    AcpToolCallStatus,
    AcpPlan,
    AcpRequestPermissionRequest,
    AcpRequestPermissionResponse,
    AcpRequestPermissionOutcome,
    AcpPermissionOption,
    AcpPermissionOptionKind,
    AcpSessionModeState,
    AcpSessionConfigOption,
    AcpContentBlock
} from './schema.js';
export { ACP_NS, ACP_MODE_ID, toAcpBlocks, toStopReason, toUsage, toToolStatus, toCategory, toConfigView, toPermissionOutcome } from './stream.js';
export type { AcpConfigOrigin, AcpConfigView } from './stream.js';
