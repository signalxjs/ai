/**
 * Our hand-written protocol subset against the generated types of Codex CLI
 * 0.153.4 (`@pwrdrvr/codex-app-server-protocol`, devDependency; `/v2` for the
 * v2 surface, the root for `initialize` / `getAuthStatus`). Plain assignments:
 * generated → ours proves we read only fields that exist with compatible
 * types; ours → generated proves what we SEND is a valid message.
 *
 * Not matched (no generated type published): `AccountReadResponse`.
 * `PermissionsRequestApprovalResponse` echoes back what Codex sent and is
 * checked in the receive direction only (its granted-profile fields are wider
 * than the subset we model).
 */
import type * as V1 from '@pwrdrvr/codex-app-server-protocol';
import type * as V2 from '@pwrdrvr/codex-app-server-protocol/v2';
import type * as S from '../src/schema';

declare const from: <T>() => T;

// Received: generated → ours.
const _1: S.TurnCompletedNotification = from<V2.TurnCompletedNotification>();
const _2: S.TurnStartedNotification = from<V2.TurnStartedNotification>();
const _3: S.ThreadTokenUsageUpdatedNotification = from<V2.ThreadTokenUsageUpdatedNotification>();
const _4: S.TurnPlanUpdatedNotification = from<V2.TurnPlanUpdatedNotification>();
const _5: S.TurnDiffUpdatedNotification = from<V2.TurnDiffUpdatedNotification>();
const _6: S.ItemDeltaNotification = from<V2.AgentMessageDeltaNotification>();
const _7: S.ItemDeltaNotification = from<V2.ReasoningTextDeltaNotification>();
const _8: S.ItemDeltaNotification = from<V2.ReasoningSummaryTextDeltaNotification>();
const _9: S.ItemDeltaNotification = from<V2.CommandExecutionOutputDeltaNotification>();
const _10: S.FileChangePatchUpdatedNotification = from<V2.FileChangePatchUpdatedNotification>();
const _11: S.ErrorNotification = from<V2.ErrorNotification>();
const _12: S.ItemNotification = from<V2.ItemStartedNotification>();
const _13: S.ItemNotification = from<V2.ItemCompletedNotification>();
const _14: S.CommandExecutionRequestApprovalParams = from<V2.CommandExecutionRequestApprovalParams>();
const _15: S.FileChangeRequestApprovalParams = from<V2.FileChangeRequestApprovalParams>();
const _16: S.PermissionsRequestApprovalParams = from<V2.PermissionsRequestApprovalParams>();
const _17: S.ToolRequestUserInputParams = from<V2.ToolRequestUserInputParams>();
const _18: S.DynamicToolCallParams = from<V2.DynamicToolCallParams>();
const _19: S.ThreadStartResponse = from<V2.ThreadStartResponse>();
const _20: S.TurnStartResponse = from<V2.TurnStartResponse>();
const _21: S.ThreadListResponse = from<V2.ThreadListResponse>();
const _22: S.ModelListResponse = from<V2.ModelListResponse>();
const _23: S.InitializeResponse = from<V1.InitializeResponse>();
const _24: S.GetAuthStatusResponse = from<V1.GetAuthStatusResponse>();

// Sent: ours → generated.
const _25: V1.InitializeParams = from<S.InitializeParams>();
const _26: V2.TurnInterruptParams = from<S.TurnInterruptParams>();
const _27: V2.ThreadListParams = from<S.ThreadListParams>();
const _28: V2.CommandExecutionRequestApprovalResponse = from<S.CommandExecutionRequestApprovalResponse>();
const _29: V2.FileChangeRequestApprovalResponse = from<S.FileChangeRequestApprovalResponse>();
const _30: V2.ToolRequestUserInputResponse = from<S.ToolRequestUserInputResponse>();
const _31: V2.DynamicToolCallResponse = from<S.DynamicToolCallResponse>();
const _32: V2.UserInput = from<S.UserInput>();
const _33: V2.DynamicToolSpec = from<S.DynamicToolFunctionSpec>();
const _34: V2.TurnStartParams = from<S.TurnStartParams>();
const _35: V2.ThreadStartParams = from<S.ThreadStartParams>();
const _36: V2.SandboxPolicy = from<S.SandboxPolicyParam>();
const _37: S.ItemDeltaNotification = from<V2.PlanDeltaNotification>();
const _38: V2.TurnSteerParams = from<S.TurnSteerParams>();
const _39: S.TurnSteerResponse = from<V2.TurnSteerResponse>();

export {};
void [_1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33, _34, _35, _36, _37, _38, _39];
