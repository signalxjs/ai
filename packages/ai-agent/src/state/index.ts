/** Transcript state — the reducer and the bridges to `@sigx/ai` messages and chunks. */

export type { TextPartState, ReasoningPartState, ToolPartState, AgentPart, AgentMessage, OpenRequest, TurnState, TranscriptError, AgentTranscript } from './transcript.js';
export { createTranscript } from './transcript.js';
export type { ReducerExtension, AgentReducer, CreateReducerOptions } from './reduce.js';
export { createReducer, reduceAgentEvent } from './reduce.js';
export { toUIMessages, toolState, toolOutput, contentToOutput } from './to-ui.js';
export type { FromUIOptions, Imported } from './from-ui.js';
export { fromUIMessages } from './from-ui.js';
export { toChatStream, toFinishReason } from './chat-stream.js';
