/**
 * @sigx/ai — AI for SignalX.
 *
 * The provider-neutral core: the `LanguageModel` seam a provider package
 * implements, the transcript and stream protocol the UI consumes,
 * `defineTool`, and the engine (`streamText` / `generateText` /
 * `streamObject` / `generateObject`) that runs the tool loop once for every
 * vendor. Zero dependencies, no `node:` imports — it runs on Node, workerd
 * and the edge alike.
 *
 * Composables live on `@sigx/ai/app`, the `serverStream` glue on
 * `@sigx/ai/server`, the scripted mock on `@sigx/ai/testing`.
 */

// Protocol
export type {
    UIMessage,
    UIPart,
    UITextPart,
    UIReasoningPart,
    UIToolPart,
    UIToolState,
    UIRole,
    UIChunk,
    FinishReason,
    Usage
} from './protocol.js';
export { isUIChunk, generateId, createMessage, userMessage, messageText } from './protocol.js';

// Model seam
export type {
    LanguageModel,
    ModelRequest,
    ModelMessage,
    ModelUserMessage,
    ModelAssistantMessage,
    ModelToolMessage,
    ModelTextPart,
    ModelReasoningPart,
    ModelToolCallPart,
    ModelToolResultPart,
    ModelEvent,
    ToolSpec
} from './model.js';
export { addUsage } from './model.js';

// Schema
export type { StandardSchemaV1, JsonSchema } from './schema.js';
export { SchemaValidationError, validateWith, jsonSchemaOf } from './schema.js';

// Tools
export type { Tool, AnyTool, ToolOptions, ToolContext } from './tool.js';
export { defineTool, findTool } from './tool.js';

// Messages
export { toModelMessages, applyChunk, assembleMessage } from './messages.js';

// Engine
export type {
    StreamTextOptions,
    StepInfo,
    GenerateTextResult,
    StreamObjectOptions,
    ObjectChunk,
    GenerateObjectResult
} from './engine.js';
export { streamText, generateText, streamObject, generateObject } from './engine.js';

// Partial JSON
export { parsePartialJson } from './partial-json.js';
