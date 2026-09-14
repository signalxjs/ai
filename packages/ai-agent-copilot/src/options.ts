/** Construction and session options for the Copilot adapter, and the slice of the SDK it uses. */

import type {
    CopilotClientOptions,
    GetAuthStatusResponse,
    MessageOptions,
    ModelInfo,
    ProviderConfig,
    ResumeSessionConfig,
    SessionConfig,
    SessionEvent,
    SessionListFilter,
    SessionMetadata,
    ToolSet
} from '@github/copilot-sdk';
import type { ConfigValue } from '@sigx/ai-agent';
import type { CodingSessionOptions } from '@sigx/ai-agent/coding';

/** The SDK's effort levels (`SessionConfigBase['reasoningEffort']`, which the SDK does not export by name). */
export type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;
/** The SDK's legacy `ask_user` handler type, likewise unexported. */
export type UserInputHandler = NonNullable<SessionConfig['onUserInputRequest']>;

export const COPILOT_NS = 'copilot';

/**
 * What the adapter needs from a `CopilotSession` — the real class satisfies
 * it (checked by `__tests__/sdk.test-d.ts`); a test hands in a scripted one.
 */
export interface CopilotSessionLike {
    readonly sessionId: string;
    send(options: MessageOptions): Promise<string>;
    abort(): Promise<void>;
    setModel(model: string, options?: { reasoningEffort?: ReasoningEffort }): Promise<void>;
    on(handler: (event: SessionEvent) => void): () => void;
    disconnect(): Promise<void>;
}

/** What the adapter needs from a `CopilotClient`; `copilot({ client })` injects one. */
export interface CopilotClientLike {
    start(): Promise<void>;
    stop(): Promise<Error[]>;
    createSession(config: SessionConfig): Promise<CopilotSessionLike>;
    resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSessionLike>;
    listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]>;
    listModels(): Promise<ModelInfo[]>;
    getAuthStatus(): Promise<GetAuthStatusResponse>;
}

export interface CopilotOptions {
    /** Default `'copilot'`. */
    readonly id?: string;
    /** A client to use instead of constructing a `CopilotClient` — a scripted fake in tests, a shared client in an app. */
    readonly client?: CopilotClientLike;
    /** The CLI runtime to spawn; default: the one the SDK bundles (or `COPILOT_CLI_PATH`). */
    readonly cliPath?: string;
    /** Environment of the runtime process; default: `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Working directory of the runtime process itself (sessions have their own `cwd`). */
    readonly cwd?: string;
    readonly logLevel?: CopilotClientOptions['logLevel'];
    /** A GitHub token, over the CLI's own login. The adapter never stores it; it goes to the runtime as an environment variable. */
    readonly gitHubToken?: string;
    /** Use the CLI's stored login (`copilot login`, `gh auth`). Default `true`; `false` when `gitHubToken` is set. */
    readonly useLoggedInUser?: boolean;
    /** `COPILOT_HOME` — where the runtime keeps sessions and settings. */
    readonly baseDirectory?: string;
    /**
     * The models the `model` config option offers; default: what the runtime
     * lists (`client.listModels()`, the enabled ones). The session's current
     * model is always offered as well.
     */
    readonly models?: readonly ConfigValue[];
    /**
     * A `session.error` the runtime does not follow with `session.idle` within
     * this many milliseconds ends the turn as an error. Default 2000.
     */
    readonly errorSettleMs?: number;
}

export interface CopilotSessionOptions extends CodingSessionOptions {
    readonly reasoningEffort?: ReasoningEffort;
    /** Restrict the runtime's built-in tools to these (names, or an SDK `ToolSet`). */
    readonly availableTools?: readonly string[] | ToolSet;
    readonly excludedTools?: readonly string[] | ToolSet;
    /** MCP servers the runtime should connect to, keyed by name. */
    readonly mcpServers?: SessionConfig['mcpServers'];
    /** A bring-your-own-key provider; such a session runs without a GitHub login. */
    readonly provider?: ProviderConfig;
    /** Stream message and reasoning deltas. Default `true`. */
    readonly streaming?: boolean;
}
