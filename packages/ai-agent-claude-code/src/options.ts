/** Construction and session options for the Claude Code adapter. */

import type { PermissionMode, SDKSessionInfo, SettingSource, SpawnOptions, SpawnedProcess, query } from '@anthropic-ai/claude-agent-sdk';
import type { CodingSessionOptions } from '@sigx/ai-agent/coding';
import type { listenMcp } from '@sigx/ai-agent-node';

/** The SDK's `query` — injectable so tests replay recorded messages through a fake. */
export type QueryFn = typeof query;
export type ListSessionsFn = (options?: { dir?: string }) => Promise<SDKSessionInfo[]>;
export type ListenFn = typeof listenMcp;

export interface ClaudeCodeOptions {
    /** Default `'claude-code'`. */
    readonly id?: string;
    /** The SDK's `query`; a fake in tests. */
    readonly query?: QueryFn;
    /** The SDK's `listSessions`; a fake in tests. */
    readonly listSessions?: ListSessionsFn;
    /** How client tools are served over MCP; `listenMcp` from `@sigx/ai-agent-node` by default. */
    readonly listen?: ListenFn;
    /** How the CLI process is spawned; `spawnAgentProcess` (tree kill, env allowlist) by default. */
    readonly spawn?: (options: SpawnOptions) => SpawnedProcess;
    /** Override the executable (the SDK's bundled platform binary otherwise). A `.cmd` / `.bat` shim is resolved first. */
    readonly pathToClaudeCodeExecutable?: string;
    /** Which Claude Code settings files apply. Default `[]` — isolated from the user's and the project's. */
    readonly settingSources?: readonly SettingSource[];
    /** Default `'default'` — every non-trivial tool asks. Never `bypassPermissions` unless `allowDangerouslySkipPermissions` is set too. */
    readonly permissionMode?: PermissionMode;
    readonly allowDangerouslySkipPermissions?: boolean;
    /** Extra environment for the CLI, on top of the allowlist (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR` pass through by default). */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** The MCP server name client tools are served under. Default `'sigx-tools'`. */
    readonly toolServerName?: string;
    /** Milliseconds between `interrupt()` and a hard abort on cancel. Default 2000. */
    readonly interruptGraceMs?: number;
}

/** Per-session options; `cwd` is required — Claude Code works in a directory. */
export interface ClaudeCodeSessionOptions extends CodingSessionOptions {
    readonly maxTurns?: number;
    readonly maxBudgetUsd?: number;
    readonly settingSources?: readonly SettingSource[];
    readonly permissionMode?: PermissionMode;
    /** Append `system` to Claude Code's own preset instead of replacing it. */
    readonly systemPromptPreset?: boolean;
}
