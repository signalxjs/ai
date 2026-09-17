/**
 * The subset of the `codex app-server` v2 protocol this adapter speaks —
 * hand-written from the generated types of Codex CLI 0.153.4
 * (`codex app-server generate-ts --experimental`; published as
 * `@pwrdrvr/codex-app-server-protocol`, a devDependency that
 * `__tests__/schema.test-d.ts` checks these shapes against). Nothing here
 * reaches the package's public surface beyond the option enums.
 */

export const CODEX_METHODS = {
    initialize: 'initialize',
    initialized: 'initialized',
    accountRead: 'account/read',
    getAuthStatus: 'getAuthStatus',
    modelList: 'model/list',
    threadStart: 'thread/start',
    threadResume: 'thread/resume',
    threadFork: 'thread/fork',
    threadList: 'thread/list',
    turnStart: 'turn/start',
    turnInterrupt: 'turn/interrupt',
    turnSteer: 'turn/steer',
    // server → client requests
    commandApproval: 'item/commandExecution/requestApproval',
    fileChangeApproval: 'item/fileChange/requestApproval',
    permissionsApproval: 'item/permissions/requestApproval',
    userInput: 'item/tool/requestUserInput',
    toolCall: 'item/tool/call',
    // server notifications
    threadStarted: 'thread/started',
    threadStatusChanged: 'thread/status/changed',
    tokenUsage: 'thread/tokenUsage/updated',
    turnStarted: 'turn/started',
    turnCompleted: 'turn/completed',
    turnDiff: 'turn/diff/updated',
    turnPlan: 'turn/plan/updated',
    itemStarted: 'item/started',
    itemCompleted: 'item/completed',
    agentMessageDelta: 'item/agentMessage/delta',
    planDelta: 'item/plan/delta',
    reasoningTextDelta: 'item/reasoning/textDelta',
    reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
    commandOutputDelta: 'item/commandExecution/outputDelta',
    patchUpdated: 'item/fileChange/patchUpdated',
    fileChangeOutputDelta: 'item/fileChange/outputDelta',
    mcpProgress: 'item/mcpToolCall/progress',
    rateLimits: 'account/rateLimits/updated',
    error: 'error',
    warning: 'warning',
    deprecation: 'deprecationNotice',
    compacted: 'thread/compacted',
    rerouted: 'model/rerouted'
} as const;

/** `serde_json::Value` as the generator renders it (object values are optional). */
export type JsonValue = number | string | boolean | JsonValue[] | { [key in string]?: JsonValue } | null;

export interface ClientInfo {
    readonly name: string;
    readonly title: string | null;
    readonly version: string;
}

export interface InitializeParams {
    readonly clientInfo: ClientInfo;
    readonly capabilities: { readonly experimentalApi: boolean; readonly requestAttestation: boolean } | null;
}

export interface InitializeResponse {
    readonly userAgent: string;
    readonly codexHome: string;
    readonly platformFamily: string;
    readonly platformOs: string;
}

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ReasoningEffort = string;

export interface DynamicToolFunctionSpec {
    type: 'function';
    name: string;
    description: string;
    inputSchema: JsonValue;
    deferLoading?: boolean;
}

export interface ThreadStartParams {
    readonly model?: string | null;
    readonly cwd?: string | null;
    readonly approvalPolicy?: AskForApproval | null;
    readonly sandbox?: SandboxMode | null;
    readonly baseInstructions?: string | null;
    readonly developerInstructions?: string | null;
    readonly dynamicTools?: DynamicToolFunctionSpec[] | null;
}

export interface ThreadResumeParams extends ThreadStartParams {
    readonly threadId: string;
}

export interface ThreadForkParams extends ThreadStartParams {
    readonly threadId: string;
}

/** Why a thread exists: a sub-agent thread says who spawned it and how deep it sits. */
export type SubAgentSource =
    | 'review'
    | 'compact'
    | 'memory_consolidation'
    | { readonly thread_spawn: { readonly parent_thread_id: string; readonly depth: number; readonly agent_path: string | null; readonly agent_nickname: string | null; readonly agent_role: string | null } }
    | { readonly other: string };

export type SessionSource = 'cli' | 'vscode' | 'exec' | 'appServer' | 'unknown' | { readonly custom: string } | { readonly subAgent: SubAgentSource };

/** The fields we read; the real `Thread` carries many more. */
export interface Thread {
    readonly id: string;
    readonly preview: string;
    readonly model: string | null;
    readonly reasoningEffort: ReasoningEffort | null;
    readonly cwd?: string;
    readonly updatedAt?: number | null;
    /** Set only when the thread is a sub-agent of another thread. */
    readonly parentThreadId?: string | null;
    readonly source?: SessionSource;
    readonly agentNickname?: string | null;
    readonly agentRole?: string | null;
}

export interface ThreadStartResponse {
    readonly thread: Thread;
    readonly model: string;
    readonly approvalPolicy: AskForApproval | { readonly granular: unknown };
    readonly sandbox: SandboxPolicy;
    readonly reasoningEffort: ReasoningEffort | null;
}

/** A sandbox policy we could send (`turn/start`): the three concrete modes. */
export type SandboxPolicyParam =
    | { readonly type: 'dangerFullAccess' }
    | { readonly type: 'readOnly'; readonly networkAccess: boolean }
    | { readonly type: 'workspaceWrite'; readonly writableRoots: string[]; readonly networkAccess: boolean; readonly excludeTmpdirEnvVar: boolean; readonly excludeSlashTmp: boolean };

/** A sandbox policy as Codex reports it — also variants we do not model (`externalSandbox`). */
export type SandboxPolicy = SandboxPolicyParam | { readonly type: string; readonly [key: string]: unknown };

export interface ThreadListParams {
    readonly cursor?: string | null;
    readonly limit?: number | null;
    readonly cwd?: string | string[] | null;
}

export interface ThreadListResponse {
    readonly data: readonly Thread[];
    readonly nextCursor: string | null;
}

/** What we send — mutable arrays, as the generated request types want them. */
export type UserInput = { type: 'text'; text: string; text_elements: never[] } | { type: 'image'; url: string } | { type: 'localImage'; path: string };

export interface TurnStartParams {
    readonly threadId: string;
    readonly input: UserInput[];
    readonly outputSchema?: JsonValue | null;
    readonly cwd?: string | null;
    readonly approvalPolicy?: AskForApproval | null;
    readonly sandboxPolicy?: SandboxPolicyParam | null;
    readonly model?: string | null;
    readonly effort?: ReasoningEffort | null;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export type CodexErrorInfo =
    | 'contextWindowExceeded'
    | 'sessionBudgetExceeded'
    | 'usageLimitExceeded'
    | 'rateLimitExceeded'
    | 'serverOverloaded'
    | 'internalServerError'
    | 'unauthorized'
    | 'badRequest'
    | 'threadRollbackFailed'
    | 'sandboxError'
    | 'other'
    | (string & {})
    | { readonly [variant: string]: unknown };

export interface TurnError {
    readonly message: string;
    readonly codexErrorInfo: CodexErrorInfo | null;
    readonly additionalDetails?: string | null;
}

export interface Turn {
    readonly id: string;
    readonly status: TurnStatus;
    readonly error: TurnError | null;
}

export interface TurnStartResponse {
    readonly turn: Turn;
}

export interface TurnInterruptParams {
    readonly threadId: string;
    readonly turnId: string;
}

/** `turn/steer`: input for the RUNNING turn; Codex refuses it when `expectedTurnId` is not the active turn. */
export interface TurnSteerParams {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly input: UserInput[];
}

export interface TurnSteerResponse {
    readonly turnId: string;
}

export interface TurnCompletedNotification {
    readonly threadId: string;
    readonly turn: Turn;
}

export interface TurnStartedNotification {
    readonly threadId: string;
    readonly turn: Turn;
}

export interface ErrorNotification {
    readonly threadId: string;
    readonly turnId: string;
    readonly error: TurnError;
    readonly willRetry: boolean;
}

export interface TokenUsageBreakdown {
    readonly totalTokens: number;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
}

export interface ThreadTokenUsageUpdatedNotification {
    readonly threadId: string;
    readonly turnId: string;
    readonly tokenUsage: { readonly total: TokenUsageBreakdown; readonly last: TokenUsageBreakdown; readonly modelContextWindow: number | null };
}

export type TurnPlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface TurnPlanUpdatedNotification {
    readonly threadId: string;
    readonly turnId: string;
    readonly explanation?: string | null;
    readonly plan: readonly { readonly step: string; readonly status: TurnPlanStepStatus }[];
}

export interface TurnDiffUpdatedNotification {
    readonly threadId: string;
    readonly turnId: string;
    readonly diff: string;
}

export type PatchChangeKind = { readonly type: 'add' } | { readonly type: 'delete' } | { readonly type: 'update'; readonly move_path: string | null };

export interface FileUpdateChange {
    readonly path: string;
    readonly kind: PatchChangeKind;
    readonly diff: string;
}

export type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type ToolCallStatus = 'inProgress' | 'completed' | 'failed';

/** The multi-agent tools Codex itself calls: `spawnAgent` starts a sub-agent thread, the rest address one. */
export type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | 'sendMessage' | 'followupTask' | 'interruptAgent' | 'listAgents';
export type CollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';
export type CollabAgentStatus = 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound';
export interface CollabAgentState {
    readonly status: CollabAgentStatus;
    readonly message: string | null;
}
export type SubAgentActivityKind = 'started' | 'interacted' | 'interrupted' | 'completed';

/** An item variant this adapter does not model — passed through as an `ext` event. */
export interface UnknownThreadItem {
    readonly type: string;
    readonly id: string;
}

export type ThreadItem = KnownThreadItem | UnknownThreadItem;

/** The item variants we map. */
export type KnownThreadItem =
    | { readonly type: 'userMessage'; readonly id: string; readonly content: readonly UserInput[] }
    | { readonly type: 'agentMessage'; readonly id: string; readonly text: string }
    | { readonly type: 'plan'; readonly id: string; readonly text: string }
    | { readonly type: 'reasoning'; readonly id: string; readonly summary: readonly string[]; readonly content: readonly string[] }
    | {
          readonly type: 'commandExecution';
          readonly id: string;
          readonly command: string;
          readonly cwd: string;
          readonly status: CommandExecutionStatus;
          readonly aggregatedOutput: string | null;
          readonly exitCode: number | null;
      }
    | { readonly type: 'fileChange'; readonly id: string; readonly changes: readonly FileUpdateChange[]; readonly status: PatchApplyStatus }
    | {
          readonly type: 'mcpToolCall';
          readonly id: string;
          readonly server: string;
          readonly tool: string;
          readonly status: ToolCallStatus;
          readonly arguments: JsonValue;
          readonly result: { readonly content: readonly JsonValue[]; readonly structuredContent: JsonValue | null } | null;
          readonly error: { readonly message: string } | null;
      }
    | {
          readonly type: 'dynamicToolCall';
          readonly id: string;
          readonly namespace: string | null;
          readonly tool: string;
          readonly arguments: JsonValue;
          readonly status: ToolCallStatus;
          readonly contentItems: readonly DynamicToolCallOutputContentItem[] | null;
          readonly success: boolean | null;
      }
    | { readonly type: 'webSearch'; readonly id: string; readonly query?: string }
    | {
          readonly type: 'collabAgentToolCall';
          readonly id: string;
          readonly tool: CollabAgentTool;
          readonly status: CollabAgentToolCallStatus;
          /** The thread that issued the call — ours, or a sub-agent delegating further. */
          readonly senderThreadId: string;
          /** The threads addressed; for `spawnAgent`, the newly spawned one. */
          readonly receiverThreadIds: readonly string[];
          readonly prompt: string | null;
          readonly model: string | null;
          readonly reasoningEffort: ReasoningEffort | null;
          /** Last known state of the target agents, by thread id. */
          readonly agentsStates: { readonly [threadId: string]: CollabAgentState | undefined };
      }
    | { readonly type: 'subAgentActivity'; readonly id: string; readonly kind: SubAgentActivityKind; readonly agentThreadId: string; readonly agentPath: string };

export interface ItemNotification {
    readonly item: ThreadItem;
    readonly threadId: string;
    readonly turnId: string;
}

export interface ItemDeltaNotification {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly delta: string;
    readonly contentIndex?: number;
    readonly summaryIndex?: number;
}

export interface FileChangePatchUpdatedNotification {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly changes: readonly FileUpdateChange[];
}

export type CommandExecutionApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel' | { readonly [variant: string]: unknown };

export interface CommandExecutionRequestApprovalParams {
    readonly kind?: 'command' | 'writeStdin';
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly approvalId?: string | null;
    readonly reason?: string | null;
    readonly command?: string | null;
    readonly cwd?: string | null;
    readonly availableDecisions?: readonly CommandExecutionApprovalDecision[] | null;
}

export interface CommandExecutionRequestApprovalResponse {
    readonly decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
}

export interface FileChangeRequestApprovalParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly reason?: string | null;
    readonly grantRoot?: string | null;
}

export interface FileChangeRequestApprovalResponse {
    readonly decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
}

export interface NetworkPermissions {
    readonly enabled: boolean | null;
}

/** Only the fields we echo back; the generated type carries more (all nullable). */
export interface FileSystemPermissions {
    readonly read?: readonly string[] | null;
    readonly write?: readonly string[] | null;
    readonly [key: string]: unknown;
}

export interface PermissionsRequestApprovalParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly cwd: string;
    readonly reason: string | null;
    readonly permissions: { readonly network: NetworkPermissions | null; readonly fileSystem: FileSystemPermissions | null };
}

export interface PermissionsRequestApprovalResponse {
    readonly permissions: { readonly network?: NetworkPermissions; readonly fileSystem?: FileSystemPermissions };
    readonly scope: 'turn' | 'session';
}

export interface ToolRequestUserInputQuestion {
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly isOther: boolean;
    readonly isSecret: boolean;
    readonly options: readonly { readonly label: string; readonly description: string }[] | null;
}

export interface ToolRequestUserInputParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly questions: readonly ToolRequestUserInputQuestion[];
    readonly isBlocking: boolean;
}

export interface ToolRequestUserInputResponse {
    readonly answers: { [id: string]: { answers: string[] } };
}

export interface DynamicToolCallParams {
    readonly threadId: string;
    readonly turnId: string;
    readonly callId: string;
    readonly namespace: string | null;
    readonly tool: string;
    readonly arguments: JsonValue;
}

export type DynamicToolCallOutputContentItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string };

export interface DynamicToolCallResponse {
    contentItems: DynamicToolCallOutputContentItem[];
    success: boolean;
}

export type Account = { readonly type: 'apiKey' } | { readonly type: 'chatgpt'; readonly email: string | null; readonly planType: string } | { readonly type: 'amazonBedrock' } | { readonly type: string };

/** UNVERIFIED shape (the `account/read` response type is not in the published subset): only `account` is read. */
export interface AccountReadResponse {
    readonly account: Account | null;
}

export interface GetAuthStatusResponse {
    readonly authMethod: string | null;
    readonly authToken: string | null;
    readonly requiresOpenaiAuth: boolean | null;
}

export interface Model {
    readonly id: string;
    readonly model: string;
    readonly displayName: string;
    readonly description: string;
    readonly hidden: boolean;
    readonly supportedReasoningEfforts: readonly { readonly reasoningEffort?: ReasoningEffort; readonly [key: string]: unknown }[];
    readonly defaultReasoningEffort: ReasoningEffort;
    readonly isDefault: boolean;
}

export interface ModelListResponse {
    readonly data: readonly Model[];
    readonly nextCursor: string | null;
}
