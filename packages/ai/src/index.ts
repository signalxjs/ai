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
} from './protocol/index.js';
export { isUIChunk, generateId, createMessage, userMessage, messageText, applyChunk, assembleMessage } from './protocol/index.js';

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
} from './model/index.js';
export { addUsage, toModelMessages } from './model/index.js';

// Schema
export type { StandardSchemaV1, JsonSchema } from './schema/index.js';
export { SchemaValidationError, validateWith, jsonSchemaOf } from './schema/index.js';

// Tools
export type { Tool, AnyTool, ToolOptions, ToolContext } from './tool/index.js';
export { defineTool, findTool } from './tool/index.js';

// Engine
export type {
    StreamTextOptions,
    StepInfo,
    GenerateTextResult,
    StreamObjectOptions,
    ObjectChunk,
    GenerateObjectResult
} from './engine/index.js';
export { streamText, generateText, streamObject, generateObject } from './engine/index.js';

// Partial JSON
export { parsePartialJson } from './utils/partial-json.js';
