/** Construction and session options for the Codex adapter. */

import type { CodingSessionOptions } from '@sigx/ai-agent/coding';
import type { AskForApproval, ReasoningEffort, SandboxMode } from './schema.js';

export interface CodexTransport {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
}

export interface CodexOptions {
    /** The executable; default `codex` (resolved on `PATH`, npm `.cmd` shims understood). */
    readonly command?: string;
    /** Default `['app-server']`. */
    readonly args?: readonly string[];
    /** Added to the allowlisted child environment. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Working directory of the app-server process itself (sessions have their own `cwd`). */
    readonly cwd?: string;
    /** `'stdio'` spawns the process; a stream pair drives an already-running server (tests, a WebSocket). Default `'stdio'`. */
    readonly transport?: 'stdio' | CodexTransport;
    /** Parent variables passed to the child besides the default allowlist. Default `['OPENAI_API_KEY', 'CODEX_HOME']`. */
    readonly passEnv?: readonly string[];
    readonly clientInfo?: { readonly name: string; readonly title?: string; readonly version: string };
    /** Default `'codex'`. */
    readonly id?: string;
}

export interface CodexSessionOptions extends CodingSessionOptions {
    /** Codex's approval policy; `untrusted` when a policy is given and nothing is said. */
    readonly approvalPolicy?: AskForApproval;
    /** Codex's sandbox; `workspace-write` when a policy is given and nothing is said. */
    readonly sandbox?: SandboxMode;
    readonly effort?: ReasoningEffort;
}

export const DEFAULT_PASS_ENV: readonly string[] = ['OPENAI_API_KEY', 'CODEX_HOME'];
