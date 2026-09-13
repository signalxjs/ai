/**
 * @sigx/ai-agent-node — the Node building blocks for `@sigx/ai-agent`
 * adapters: a cross-platform process supervisor, executable resolution that
 * understands Windows (`Path`, `PATHEXT`, npm `.cmd` shims), a child
 * environment allowlist, and a loopback MCP listener. Kept out of
 * `@sigx/ai-agent` so that package stays edge-safe.
 */

export type { BuildChildEnvOptions } from './env.js';
export { DEFAULT_ENV_ALLOWLIST, buildChildEnv, envKey } from './env.js';
export type { ExecutableKind, ResolvedExecutable, ResolveExecutableOptions } from './resolve.js';
export { resolveExecutable, parseCmdShim, ExecutableNotFoundError } from './resolve.js';
export type { SpawnAgentProcessOptions, ProcessExit, AgentProcess } from './spawn.js';
export { spawnAgentProcess, ProcessExitedError, UnsafeArgumentError, quoteForCmd, cmdShimArgs } from './spawn.js';
export { registerChild, unregisterChild, registeredChildren, killTreeSync, installSignalForwarding } from './exit-registry.js';
export type { ListenMcpOptions, McpListener } from './mcp-listen.js';
export { listenMcp, toRequest, sendResponse } from './mcp-listen.js';
