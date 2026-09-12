/** The provider seam: `LanguageModel`, its request/message/event shapes, and the UI → model conversion. */

export type { LanguageModel, ModelRequest, ToolSpec } from './language-model.js';
export type {
    ModelMessage,
    ModelUserMessage,
    ModelAssistantMessage,
    ModelToolMessage,
    ModelTextPart,
    ModelReasoningPart,
    ModelToolCallPart,
    ModelToolResultPart
} from './message.js';
export type { ModelEvent } from './event.js';
export { addUsage } from './event.js';
export { toModelMessages } from './from-ui.js';
