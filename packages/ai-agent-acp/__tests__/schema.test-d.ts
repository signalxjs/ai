/**
 * Our hand-written protocol subset must stay assignable to (and from) the
 * reference SDK's generated types — a devDependency, never shipped.
 */
import { expectTypeOf } from 'vitest';
import type * as Sdk from '@agentclientprotocol/sdk';
import type {
    AcpInitializeRequest,
    AcpInitializeResponse,
    AcpNewSessionRequest,
    AcpNewSessionResponse,
    AcpPromptRequest,
    AcpPromptResponse,
    AcpRequestPermissionRequest,
    AcpRequestPermissionResponse,
    AcpSessionNotification,
    AcpStopReason,
    AcpToolKind,
    AcpToolCallStatus,
    AcpPermissionOptionKind,
    AcpSessionModeState
} from '@sigx/ai-agent-acp';

// What we send must be what the SDK accepts.
expectTypeOf<AcpInitializeRequest>().toMatchTypeOf<Sdk.InitializeRequest>();
expectTypeOf<AcpNewSessionRequest>().toMatchTypeOf<Sdk.NewSessionRequest>();
expectTypeOf<AcpPromptRequest>().toMatchTypeOf<Sdk.PromptRequest>();
expectTypeOf<AcpRequestPermissionResponse>().toMatchTypeOf<Sdk.RequestPermissionResponse>();

// What the SDK sends must fit what we read.
expectTypeOf<Sdk.InitializeResponse>().toMatchTypeOf<AcpInitializeResponse>();
expectTypeOf<Sdk.NewSessionResponse['sessionId']>().toEqualTypeOf<AcpNewSessionResponse['sessionId']>();
expectTypeOf<Sdk.NewSessionResponse['modes']>().toMatchTypeOf<AcpNewSessionResponse['modes']>();
expectTypeOf<Sdk.PromptResponse>().toMatchTypeOf<AcpPromptResponse>();
expectTypeOf<Sdk.RequestPermissionRequest>().toMatchTypeOf<AcpRequestPermissionRequest>();
expectTypeOf<Sdk.SessionNotification['sessionId']>().toEqualTypeOf<AcpSessionNotification['sessionId']>();
expectTypeOf<Sdk.SessionUpdate['sessionUpdate']>().toEqualTypeOf<AcpSessionNotification['update']['sessionUpdate']>();
expectTypeOf<Sdk.SessionModeState>().toMatchTypeOf<AcpSessionModeState>();

// Closed enumerations must match exactly.
expectTypeOf<Sdk.StopReason>().toEqualTypeOf<AcpStopReason>();
expectTypeOf<Sdk.ToolKind>().toEqualTypeOf<AcpToolKind>();
expectTypeOf<Sdk.ToolCallStatus>().toEqualTypeOf<AcpToolCallStatus>();
expectTypeOf<Sdk.PermissionOptionKind>().toEqualTypeOf<AcpPermissionOptionKind>();
