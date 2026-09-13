/** @sigx/ai-agent-claude-code — Claude Code as an `Agent`, on the official Claude Agent SDK. */

export type { ClaudeCodeOptions, ClaudeCodeSessionOptions, QueryFn, ListSessionsFn, ListenFn } from './options.js';
export { claudeCode, CLAUDE_CODE_CAPABILITIES, DEFAULT_TOOL_SERVER, spawnForSdk } from './provider.js';
export { CLAUDE_CODE_NS, assistantErrorCode } from './stream.js';
export { splitToolName, primaryArg, toolAnnotations, toUserMessage, toOutputFormat, toQueryOptions, childEnv, PERMISSION_MODES } from './request.js';
export { startToolServer, bearerToken, sameToken } from './tools.js';
export type { ToolServer } from './tools.js';
