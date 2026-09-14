/** @sigx/ai-agent-claude-code — Claude Code as an `Agent`, on the official Claude Agent SDK. */

export type { ClaudeCodeOptions, ClaudeCodeSessionOptions, QueryFn, ListSessionsFn, ListenFn } from './options.js';
export { claudeCode, CLAUDE_CODE_CAPABILITIES, DEFAULT_TOOL_SERVER, spawnForSdk } from './provider.js';
export { CLAUDE_CODE_NS, assistantErrorCode } from './stream.js';
export { createAgentTracker, taskKind } from './tasks.js';
export type { AgentTracker, TrackedAgent, TaskKind } from './tasks.js';
export {
    splitToolName,
    primaryArg,
    toolAnnotations,
    toUserMessage,
    toOutputFormat,
    toQueryOptions,
    toAgentDefinitions,
    childEnv,
    configOptions,
    createConfigState,
    resolveThinking,
    thinkingDisplayOf,
    thinkingBudgetOf,
    PERMISSION_MODES,
    THINKING_DISPLAYS,
    DEFAULT_THINKING
} from './request.js';
export type { ThinkingDisplay, ConfigState, ConfigTracker } from './request.js';
export { ASK_USER_QUESTION, questionId, parseQuestions, questionsSchema, questionOptions, questionsMessage, toAskAnswers } from './questions.js';
export type { AskQuestion } from './questions.js';
export { startToolServer, bearerToken, sameToken } from './tools.js';
export type { ToolServer } from './tools.js';
