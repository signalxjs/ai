/** Construction and session options for the Claude Code adapter. */

import type { PermissionMode, SDKSessionInfo, SettingSource, SpawnOptions, SpawnedProcess, ThinkingConfig, query } from '@anthropic-ai/claude-agent-sdk';
import type { ConfigValue } from '@sigx/ai-agent';
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
    /**
     * The models the `model` config option offers. Default
     * `CLAUDE_CODE_MODELS`; replace it for a gateway, for Bedrock / Vertex
     * ids, or to offer a model the default list leaves out. The session's
     * current model is always offered as well.
     */
    readonly models?: readonly ConfigValue[];
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
    /**
     * Forward a sub-agent's text and thinking as nested parts (`parentCallId`, `actor`).
     * Default `true`; `false` keeps only its tool calls, the SDK's own default.
     */
    readonly subagentTranscript?: boolean;
    /** Ask the CLI for model-written progress summaries on `agent-update` (costs extra model calls). Default `false`. */
    readonly agentProgressSummaries?: boolean;
    /**
     * Claude's thinking, the way `@sigx/ai-anthropic` takes `thinking` — the
     * SDK's own `ThinkingConfig`. Default `{ type: 'adaptive', display:
     * 'summarized' }`: the CLI's default display is `omitted`, which streams
     * one empty `thinking_delta` per progress tick and leaves every reasoning
     * part blank. Summaries are free — the raw thinking they describe is
     * billed either way (measured: `output_tokens` tracks `thinking_tokens`
     * identically in both modes) — so they are on by default, as they are in
     * Claude Code itself.
     *
     * `null` sends no `thinking` at all, so the session inherits Claude Code's
     * own default (`thinking.display` in settings / `--thinking-display`).
     */
    readonly thinking?: ThinkingConfig | null;
}
