/**
 * @sigx/ai/app — the composables.
 *
 * Built on `@sigx/runtime-core` and `@sigx/reactivity`, never the `sigx`
 * umbrella (which drags the DOM renderer in), so a terminal or Lynx app
 * uses them unchanged.
 */

export { useChat } from './use-chat.js';
export type { Chat, ChatStatus, ChatStreamInput, UseChatOptions } from './use-chat.js';
export { useCompletion } from './use-completion.js';
export type { Completion, CompletionStatus } from './use-completion.js';
export { useObject } from './use-object.js';
export type { StreamedObject, ObjectStatus, UseObjectOptions, ObjectSourceChunk } from './use-object.js';
export type { UIMessage, UIPart, UIChunk } from '../protocol.js';
export { userMessage, messageText, createMessage } from '../protocol.js';
