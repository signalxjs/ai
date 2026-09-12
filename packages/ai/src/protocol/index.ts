/** The UI wire protocol — transcript types, stream chunks, and the reducer that folds one into the other. */

export type { UIRole, UIMessage, UIPart, UITextPart, UIReasoningPart, UIToolState, UIToolPart } from './message.js';
export { generateId, createMessage, userMessage, messageText } from './message.js';
export type { FinishReason, Usage, UIChunk } from './chunk.js';
export { isUIChunk } from './chunk.js';
export { applyChunk, assembleMessage } from './reduce.js';
