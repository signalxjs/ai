/**
 * What the playground can run, and what a live session looks like — shared by
 * the server and the browser.
 *
 * This is deliberately NOT a `*.server.ts` module. `@sigx/vite` replaces one
 * of those wholesale in the client build, and a re-export cannot be stubbed,
 * so the types the UI needs have to live somewhere the browser may import.
 * Everything here is data and types: no agent, no SDK, no key.
 */

import type { AgentCapabilities, ConfigOption, SessionState } from '@sigx/ai-agent';

/**
 * Every agent the playground offers. `sigx` is our own engine (`modelAgent`),
 * `mock` the scripted one from `@sigx/ai-agent/testing` — both run with no key
 * and nothing installed. The rest are harness adapters on your own login.
 */
export const AGENTS = ['sigx', 'mock', 'claude-code', 'codex', 'copilot', 'acp:gemini', 'acp:cursor', 'acp:claude-code', 'acp:codex', 'acp:copilot'] as const;
export type AgentChoice = (typeof AGENTS)[number];
export type HarnessChoice = Exclude<AgentChoice, 'sigx' | 'mock'>;

/** How to get the CLI a harness needs — shown when it is not on PATH. */
export const INSTALL: Record<HarnessChoice, string> = {
    'claude-code': 'npm i -g @anthropic-ai/claude-code',
    codex: 'npm i -g @openai/codex',
    copilot: 'the SDK bundles the Copilot CLI runtime; sign in with copilot login (npm i -g @github/copilot)',
    'acp:gemini': 'npm i -g @google/gemini-cli',
    'acp:cursor': 'the Cursor CLI (`agent`), see https://cursor.com/cli',
    'acp:claude-code': 'npm i -g @agentclientprotocol/claude-agent-acp',
    'acp:codex': 'npm i -g @agentclientprotocol/codex-acp',
    'acp:copilot': 'npm i -g @github/copilot'
};

/**
 * Four sessions, not more. Each one holds an NDJSON `serverStream` open, and
 * an HTTP/1.1 browser allows about six sockets per origin — past that the
 * command POSTs queue behind the streams and the page stops responding with
 * nothing to show for it. A real app multiplexes one stream, or serves HTTP/2.
 */
export const MAX_SESSIONS = 4;

export interface ModelChoice {
    readonly id: string;
    readonly label?: string;
}

export interface CatalogEntry {
    readonly id: AgentChoice;
    readonly label: string;
    readonly kind: 'engine' | 'mock' | 'harness';
    /**
     * Models we can name before opening a session. Empty for a harness: it
     * reports its own as a `config` option once the session is up, which is
     * the authoritative list.
     */
    readonly models: readonly ModelChoice[];
    /** A harness works in a directory; our engine and the mock do not care. */
    readonly needsCwd: boolean;
    readonly install?: string;
    /** Why the last attempt to open this agent failed — learned, never probed. */
    readonly unavailable?: string;
}

export interface AgentCatalog {
    readonly agents: readonly CatalogEntry[];
    readonly defaults: { readonly agent: AgentChoice; readonly model?: string; readonly cwd: string };
    readonly maxSessions: number;
}

/** A live session, as the sidebar shows it. */
export interface SessionInfo {
    readonly sessionId: string;
    readonly agent: AgentChoice;
    /** `agent.id` as the adapter reports it. */
    readonly agentId: string;
    readonly model?: string;
    readonly cwd?: string;
    readonly capabilities: AgentCapabilities;
    readonly config: readonly ConfigOption[];
    readonly state: SessionState;
    readonly createdAt: number;
}

export interface OpenRequest {
    readonly agent: AgentChoice;
    readonly model?: string;
    readonly cwd?: string;
}

/**
 * Opening a session answers rather than throws: a missing CLI is an install
 * hint to render next to the form, not an exception to plumb through.
 */
export type OpenResult = { readonly ok: true; readonly session: SessionInfo } | { readonly ok: false; readonly reason: string };

/** The label a sidebar row shows for the mode a session is in, whatever the agent calls it. */
export function modeOf(config: readonly ConfigOption[]): string | undefined {
    // Every adapter names its mode differently (`permissionMode`, `mode`,
    // `approvalPolicy`, `sandbox`), so read the first option that is not the
    // model rather than keeping a list of ids in step with four adapters.
    return config.find((o) => o.id !== 'model')?.current;
}
