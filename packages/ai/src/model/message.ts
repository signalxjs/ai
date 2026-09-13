/** The conversation as a provider sees it — one message per role turn, tool results in ONE message. */

import type { UIFilePart, UIImagePart } from '../protocol/index.js';

export type ModelMessage = ModelUserMessage | ModelAssistantMessage | ModelToolMessage;

/** A string when the user sent only text; the ordered parts otherwise. */
export interface ModelUserMessage {
    readonly role: 'user';
    readonly content: string | readonly ModelUserPart[];
}

export type ModelUserPart = ModelTextPart | ModelImagePart | ModelFilePart;

/** Same shape as the UI part — `toModelMessages` passes it through; the provider translates. */
export type ModelImagePart = UIImagePart;
export type ModelFilePart = UIFilePart;

export interface ModelAssistantMessage {
    readonly role: 'assistant';
    readonly content: readonly (ModelTextPart | ModelReasoningPart | ModelToolCallPart)[];
}

/** The results of every tool call in the previous assistant turn — ONE message. */
export interface ModelToolMessage {
    readonly role: 'tool';
    readonly content: readonly ModelToolResultPart[];
}

export interface ModelTextPart {
    readonly type: 'text';
    readonly text: string;
}

export interface ModelReasoningPart {
    readonly type: 'reasoning';
    readonly text: string;
    /** Provider replay data (a signed thinking block); passed back verbatim. */
    readonly providerData?: unknown;
}

export interface ModelToolCallPart {
    readonly type: 'tool-call';
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
}

export interface ModelToolResultPart {
    readonly type: 'tool-result';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly output: unknown;
    readonly isError?: boolean;
}
