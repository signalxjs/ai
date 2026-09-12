/** The conversation as a provider sees it — one message per role turn, tool results in ONE message. */

export type ModelMessage = ModelUserMessage | ModelAssistantMessage | ModelToolMessage;

export interface ModelUserMessage {
    readonly role: 'user';
    readonly content: string | readonly ModelTextPart[];
}

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
