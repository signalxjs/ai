/**
 * Presets — the command lines of agents that document ACP support. Data
 * only: spread one into `acp()` and override what you need. Adding a preset
 * is adding an object here; nothing else in the adapter is vendor-specific.
 */

import type { AcpPreset } from './options.js';

/** Gemini CLI (`@google/gemini-cli`): `gemini --experimental-acp`. */
export function gemini(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:gemini', command: 'gemini', args: ['--experimental-acp'], passEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], ...overrides };
}

/** Cursor's CLI agent (`curl https://cursor.com/install -fsS | bash`): `agent acp`. */
export function cursor(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:cursor', command: 'agent', args: ['acp'], passEnv: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'], ...overrides };
}

/**
 * Claude Code through its ACP bridge (`@agentclientprotocol/claude-agent-acp`):
 * `claude-agent-acp`. The bridge moved out of `@zed-industries`, where
 * `@zed-industries/claude-code-acp` is deprecated and installs the older
 * `claude-code-acp` command — pass `{ command: 'claude-code-acp' }` to keep
 * using it.
 */
export function claudeCodeAcp(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:claude-code', command: 'claude-agent-acp', args: [], passEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'], ...overrides };
}

/**
 * Codex through its ACP bridge (`@agentclientprotocol/codex-acp`): `codex-acp`.
 * Same command as the deprecated `@zed-industries/codex-acp`; only the package
 * to install changed.
 */
export function codexAcp(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:codex', command: 'codex-acp', args: [], passEnv: ['OPENAI_API_KEY', 'CODEX_HOME'], ...overrides };
}

/**
 * GitHub Copilot CLI's own ACP server (`@github/copilot`, public preview):
 * `copilot --acp`. It runs on the CLI's login (`copilot login`) or a GitHub
 * token from the environment; `@sigx/ai-agent-copilot` is the full-fidelity
 * adapter on the official SDK.
 */
export function copilotAcp(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:copilot', command: 'copilot', args: ['--acp'], passEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_HOME'], ...overrides };
}
