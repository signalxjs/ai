/**
 * @sigx/ai-agent/app — the composable.
 *
 * Built on `@sigx/runtime-core` and `@sigx/reactivity`, never the `sigx`
 * umbrella (which drags the DOM renderer in), so a terminal or Lynx app uses
 * it unchanged. Types only beyond `useAgentSession`: the runtime pieces a UI
 * also wants (`toUIMessages`, `codingExtension`) live in the entries that own
 * them, so this one stays the composable and nothing else.
 */

export { useAgentSession } from './use-agent-session.js';
export type { AgentSessionSource, AgentSessionView, UseAgentSessionOptions } from './use-agent-session.js';
export type { AgentMessage, AgentPart, AgentTranscript, OpenRequest, ReasoningPartState, ReducerExtension, TextPartState, ToolPartState, TranscriptError, TurnState } from '../state/index.js';
export type { AgentCapabilities, AgentEvent, ConfigOption, Decision, PromptInput, RequestOption, SessionState, ToolStatus } from '../protocol/index.js';
export type { TurnResult } from '../session/index.js';
