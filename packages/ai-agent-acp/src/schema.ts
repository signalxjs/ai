/**
 * The Agent Client Protocol, the subset this adapter speaks — hand-written so
 * the package has no runtime dependency on the protocol SDK (which pulls in a
 * validation library). `__tests__/schema.test-d.ts` checks these types
 * against `@agentclientprotocol/sdk` so drift fails the typecheck.
 *
 * Protocol version 1 — https://agentclientprotocol.com
 */

export const ACP_PROTOCOL_VERSION = 1;

/** `RequestError.authRequired()` in the reference SDK. */
export const ACP_AUTH_REQUIRED = -32000;

export const ACP_METHODS = {
    initialize: 'initialize',
    authenticate: 'authenticate',
    sessionNew: 'session/new',
    sessionLoad: 'session/load',
    sessionResume: 'session/resume',
    sessionFork: 'session/fork',
    sessionList: 'session/list',
    sessionClose: 'session/close',
    sessionSetMode: 'session/set_mode',
    sessionSetConfigOption: 'session/set_config_option',
    sessionPrompt: 'session/prompt',
    sessionCancel: 'session/cancel',
    sessionRequestPermission: 'session/request_permission',
    sessionUpdate: 'session/update',
    fsReadTextFile: 'fs/read_text_file',
    fsWriteTextFile: 'fs/write_text_file',
    terminalCreate: 'terminal/create',
    terminalOutput: 'terminal/output',
    terminalRelease: 'terminal/release',
    terminalWaitForExit: 'terminal/wait_for_exit',
    terminalKill: 'terminal/kill'
} as const;

export interface AcpImplementation {
    name: string;
    title?: string | null;
    version: string;
}

export interface AcpFileSystemCapabilities {
    readTextFile?: boolean;
    writeTextFile?: boolean;
}

export interface AcpClientCapabilities {
    fs?: AcpFileSystemCapabilities;
    terminal?: boolean;
}

export interface AcpInitializeRequest {
    protocolVersion: number;
    clientCapabilities?: AcpClientCapabilities;
    clientInfo?: AcpImplementation | null;
}

export interface AcpPromptCapabilities {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
}

export interface AcpMcpCapabilities {
    http?: boolean;
    sse?: boolean;
    acp?: boolean;
}

/** `{}` (or any object) advertises support; omitted or `null` does not. */
export interface AcpSessionCapabilities {
    list?: object | null;
    delete?: object | null;
    additionalDirectories?: object | null;
    fork?: object | null;
    resume?: object | null;
    close?: object | null;
}

export interface AcpAgentCapabilities {
    loadSession?: boolean;
    promptCapabilities?: AcpPromptCapabilities;
    mcpCapabilities?: AcpMcpCapabilities;
    sessionCapabilities?: AcpSessionCapabilities;
}

export interface AcpAuthMethod {
    id: string;
    name: string;
    description?: string | null;
    type?: string;
}

export interface AcpInitializeResponse {
    protocolVersion: number;
    agentCapabilities?: AcpAgentCapabilities;
    authMethods?: AcpAuthMethod[];
    agentInfo?: AcpImplementation | null;
}

export interface AcpHttpHeader {
    name: string;
    value: string;
}

export interface AcpEnvVariable {
    name: string;
    value: string;
}

export type AcpMcpServer =
    | { type: 'http'; name: string; url: string; headers: AcpHttpHeader[] }
    | { type: 'sse'; name: string; url: string; headers: AcpHttpHeader[] }
    | { name: string; command: string; args: string[]; env: AcpEnvVariable[] };

export interface AcpSessionMode {
    id: string;
    name: string;
    description?: string | null;
}

export interface AcpSessionModeState {
    currentModeId: string;
    availableModes: AcpSessionMode[];
}

export interface AcpSessionConfigSelectOption {
    value: string;
    name: string;
    description?: string | null;
}

export type AcpSessionConfigOption = {
    id: string;
    name: string;
    description?: string | null;
    category?: string | null;
} & ({ type: 'select'; currentValue: string; options: AcpSessionConfigSelectOption[] } | { type: 'boolean'; currentValue: boolean });

export interface AcpNewSessionRequest {
    cwd: string;
    additionalDirectories?: string[];
    mcpServers: AcpMcpServer[];
}

export interface AcpNewSessionResponse {
    sessionId: string;
    modes?: AcpSessionModeState | null;
    configOptions?: AcpSessionConfigOption[] | null;
}

export interface AcpLoadSessionRequest {
    sessionId: string;
    cwd: string;
    additionalDirectories?: string[];
    mcpServers: AcpMcpServer[];
}

export interface AcpResumeSessionRequest {
    sessionId: string;
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: AcpMcpServer[];
}

export interface AcpResumeSessionResponse {
    modes?: AcpSessionModeState | null;
    configOptions?: AcpSessionConfigOption[] | null;
}

export interface AcpForkSessionRequest {
    sessionId: string;
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: AcpMcpServer[];
}

export type AcpForkSessionResponse = AcpNewSessionResponse;

export interface AcpListSessionsRequest {
    cwd?: string | null;
    cursor?: string | null;
}

export interface AcpSessionInfo {
    sessionId: string;
    cwd: string;
    title?: string | null;
    updatedAt?: string | null;
}

export interface AcpListSessionsResponse {
    sessions: AcpSessionInfo[];
    nextCursor?: string | null;
}

export type AcpContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string; uri?: string | null }
    | { type: 'audio'; data: string; mimeType: string }
    | { type: 'resource_link'; uri: string; name: string; mimeType?: string | null; title?: string | null; description?: string | null }
    | { type: 'resource'; resource: { uri: string; mimeType?: string | null; text: string } | { uri: string; mimeType?: string | null; blob: string } };

export interface AcpPromptRequest {
    sessionId: string;
    prompt: AcpContentBlock[];
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface AcpUsage {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens?: number | null;
    cachedReadTokens?: number | null;
    cachedWriteTokens?: number | null;
}

export interface AcpPromptResponse {
    stopReason: AcpStopReason;
    usage?: AcpUsage | null;
}

export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AcpToolCallLocation {
    path: string;
    line?: number | null;
}

export type AcpToolCallContent =
    | { type: 'content'; content: AcpContentBlock }
    | { type: 'diff'; path: string; oldText?: string | null; newText: string }
    | { type: 'terminal'; terminalId: string };

export interface AcpToolCall {
    toolCallId: string;
    title: string;
    name?: string | null;
    kind?: AcpToolKind;
    status?: AcpToolCallStatus;
    content?: AcpToolCallContent[];
    locations?: AcpToolCallLocation[];
    rawInput?: unknown;
    rawOutput?: unknown;
}

export interface AcpToolCallUpdate {
    toolCallId: string;
    kind?: AcpToolKind | null;
    status?: AcpToolCallStatus | null;
    title?: string | null;
    name?: string | null;
    content?: AcpToolCallContent[] | null;
    locations?: AcpToolCallLocation[] | null;
    rawInput?: unknown;
    rawOutput?: unknown;
}

export interface AcpPlanEntry {
    content: string;
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'in_progress' | 'completed';
}

export interface AcpPlan {
    entries: AcpPlanEntry[];
}

export interface AcpUsageUpdate {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
}

export interface AcpContentChunk {
    content: AcpContentBlock;
    messageId?: string | null;
}

export type AcpSessionUpdate =
    | (AcpContentChunk & { sessionUpdate: 'user_message_chunk' })
    | (AcpContentChunk & { sessionUpdate: 'agent_message_chunk' })
    | (AcpContentChunk & { sessionUpdate: 'agent_thought_chunk' })
    | (AcpToolCall & { sessionUpdate: 'tool_call' })
    | (AcpToolCallUpdate & { sessionUpdate: 'tool_call_update' })
    | (AcpPlan & { sessionUpdate: 'plan' })
    | { sessionUpdate: 'plan_update'; plan: unknown }
    | { sessionUpdate: 'plan_removed' }
    | { sessionUpdate: 'available_commands_update'; availableCommands: unknown[] }
    | { sessionUpdate: 'current_mode_update'; currentModeId: string }
    | { sessionUpdate: 'config_option_update'; configOptions: AcpSessionConfigOption[] }
    | { sessionUpdate: 'session_info_update'; title?: string | null; updatedAt?: string | null }
    | (AcpUsageUpdate & { sessionUpdate: 'usage_update' })
    | { sessionUpdate: 'compaction_update'; [key: string]: unknown }
    | (AcpContentChunk & { sessionUpdate: 'compaction_summary_chunk' });

export interface AcpSessionNotification {
    sessionId: string;
    update: AcpSessionUpdate;
}

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionOption {
    optionId: string;
    name: string;
    kind: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionRequest {
    sessionId: string;
    toolCall: AcpToolCallUpdate;
    options: AcpPermissionOption[];
}

export type AcpRequestPermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };

export interface AcpRequestPermissionResponse {
    outcome: AcpRequestPermissionOutcome;
}

export interface AcpSetSessionModeRequest {
    sessionId: string;
    modeId: string;
}

export type AcpSetSessionConfigOptionRequest = { sessionId: string; configId: string } & ({ type: 'boolean'; value: boolean } | { value: string });

export interface AcpCancelNotification {
    sessionId: string;
}

export interface AcpReadTextFileRequest {
    sessionId: string;
    path: string;
    line?: number | null;
    limit?: number | null;
}

export interface AcpReadTextFileResponse {
    content: string;
}

export interface AcpWriteTextFileRequest {
    sessionId: string;
    path: string;
    content: string;
}

export interface AcpCreateTerminalRequest {
    sessionId: string;
    command: string;
    args?: string[];
    env?: AcpEnvVariable[];
    cwd?: string | null;
    outputByteLimit?: number | null;
}

export interface AcpCreateTerminalResponse {
    terminalId: string;
}

export interface AcpTerminalRequest {
    sessionId: string;
    terminalId: string;
}

export interface AcpTerminalExitStatus {
    exitCode?: number | null;
    signal?: string | null;
}

export interface AcpTerminalOutputResponse {
    output: string;
    truncated: boolean;
    exitStatus?: AcpTerminalExitStatus | null;
}

export type AcpWaitForTerminalExitResponse = AcpTerminalExitStatus;
