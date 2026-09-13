/** Construction and session options for the ACP adapter. */

import type { CodingSessionOptions } from '@sigx/ai-agent/coding';
import type { AcpImplementation, AcpMcpServer } from './schema.js';

/** A ready-made pair of Web Streams — an agent reachable over a socket, a fake in tests. */
export interface AcpTransportStreams {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
}

export interface AcpOptions {
    /** The agent executable (`gemini`, `agent`, …); resolved on `PATH` like a shell would, `.cmd` shims included. */
    readonly command?: string;
    readonly args?: readonly string[];
    /** Added to the allowlisted child environment (`undefined` removes). */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Working directory of the agent process (not of its sessions — that is `cwd` on each session). */
    readonly cwd?: string;
    /** `'stdio'` (default) spawns `command`; a stream pair drives an agent that is already running. */
    readonly transport?: 'stdio' | AcpTransportStreams;
    /** Offer `fs/read_text_file` / `fs/write_text_file` to the agent (each goes through `denyOutside(cwd)` and the session policy). Off by default. */
    readonly fs?: { readonly read?: boolean; readonly write?: boolean };
    /** Offer `terminal/*` to the agent (commands run through `spawnAgentProcess` under the session policy). Off by default. */
    readonly terminal?: boolean;
    /** Parent environment variables to pass to the agent besides the allowlist (an API key the vendor reads). */
    readonly passEnv?: readonly string[];
    /** Sent in `initialize`. */
    readonly clientInfo?: AcpImplementation;
    /** The agent id (`acp`, or `acp:gemini` from a preset). */
    readonly id?: string;
}

/** What a preset supplies — spread it into `acp()` and override what you need. */
export type AcpPreset = Pick<AcpOptions, 'command' | 'args' | 'env' | 'passEnv' | 'id'>;

export interface AcpSessionOptions extends CodingSessionOptions {
    /** Further MCP servers the agent should connect to (client tools are added automatically). */
    readonly mcpServers?: readonly AcpMcpServer[];
}
