/** `@sigx/ai/server` — the glue between the engine and a `serverStream`. */

export type { StreamTextOptions } from '../engine/index.js';
export type { ChatStreamOptions } from './chat-stream.js';
export { chatStream, toTextStream } from './chat-stream.js';
export { ChatInput } from './chat-input.js';
