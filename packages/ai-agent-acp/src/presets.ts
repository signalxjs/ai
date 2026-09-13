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

/** Cursor's CLI agent: `agent acp`. */
export function cursor(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:cursor', command: 'agent', args: ['acp'], passEnv: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'], ...overrides };
}

/** Claude Code through Zed's ACP bridge (`@zed-industries/claude-code-acp`). */
export function claudeCodeAcp(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:claude-code', command: 'claude-code-acp', args: [], passEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'], ...overrides };
}

/** Codex through Zed's ACP bridge (`@zed-industries/codex-acp`). */
export function codexAcp(overrides: Partial<AcpPreset> = {}): AcpPreset {
    return { id: 'acp:codex', command: 'codex-acp', args: [], passEnv: ['OPENAI_API_KEY', 'CODEX_HOME'], ...overrides };
}
