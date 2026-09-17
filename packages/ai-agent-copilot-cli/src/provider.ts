/**
 * `copilotCli()` — GitHub Copilot CLI as an `Agent`, on the official
 * `@github/copilot-sdk`.
 *
 * One `CopilotClient` (one runtime process, spawned by the SDK) per agent,
 * started lazily on the first session; each session is a Copilot session
 * with `onEvent`, the permission handlers and the client tools wired to our
 * session before the runtime says a word. The adapter never collects or
 * stores credentials — the CLI's own login is the user's business, and a
 * `gitHubToken` goes straight to the runtime's environment.
 */

import type { CopilotClientOptions, ModelInfo, SessionConfig } from '@github/copilot-sdk';
import type { AnyTool } from '@sigx/ai';
import type { Agent, AgentCapabilities, ConfigValue, SessionSummary } from '@sigx/ai-agent';
import { AgentError, capabilities } from '@sigx/ai-agent';
import type { CopilotClientLike, CopilotCliOptions, CopilotCliSessionOptions } from './options.js';
import { toClientOptions, toModelValues, toSessionConfig } from './request.js';
import { createCopilotSession, type CopilotSession } from './session.js';

export const COPILOT_CLI_CAPABILITIES: AgentCapabilities = capabilities({
    resume: 'local',
    fork: false,
    cancel: true,
    // No same-turn injection: the runtime would queue a second message as a turn of its
    // own, so the session core refuses a prompt while one runs (SessionBusyError).
    steer: false,
    config: true,
    structuredOutput: false,
    // `send()` takes text and file paths, not inline images.
    promptParts: 'text',
    tools: 'native',
    // The runtime asks for shell, writes, URLs and MCP; reads inside the workspace run without asking.
    permissions: 'harness-filtered',
    listSessions: true,
    // `subagent.*` events and the sub-agent's own events (nested); the SDK has no per-agent cancel.
    subagents: 'observe',
    // `session({ agents })` becomes the session's `customAgents`.
    defineAgents: true
});

export const DEFAULT_ERROR_SETTLE_MS = 2000;

interface Connection {
    readonly client: CopilotClientLike;
    readonly owned: boolean;
    readonly authenticated: boolean;
    readonly models: ModelInfo[];
}

export interface CopilotCliAgent extends Agent<CopilotCliSessionOptions> {
    listSessions(): Promise<SessionSummary[]>;
}

export function copilotCli(options: CopilotCliOptions = {}): CopilotCliAgent {
    const id = options.id ?? 'copilot-cli';
    const sessions = new Map<string, CopilotSession>();
    let connecting: Promise<Connection> | undefined;
    let disposed = false;

    const connect = (): Promise<Connection> => {
        if (disposed) return Promise.reject(new AgentError('protocol_error', `[sigx ai-agent-copilot-cli] agent "${id}" is disposed`));
        return (connecting ??= (async () => {
            const client = options.client ?? (await createClient(options));
            try {
                await client.start();
            } catch (e) {
                throw new AgentError('process_exited', `[sigx ai-agent-copilot-cli] the Copilot runtime did not start: ${e instanceof Error ? e.message : String(e)}`, false, { cause: e });
            }
            const status = await client.getAuthStatus().catch(() => ({ isAuthenticated: false }));
            const models = status.isAuthenticated ? await client.listModels().catch((): ModelInfo[] => []) : [];
            return { client, owned: !options.client, authenticated: status.isAuthenticated, models };
        })().catch((e: unknown) => {
            connecting = undefined;
            throw e;
        }));
    };

    async function openSession(sessionOptions: CopilotCliSessionOptions): Promise<CopilotSession> {
        if (!sessionOptions?.cwd) throw new AgentError('protocol_error', '[sigx ai-agent-copilot-cli] session options need a cwd');
        const resume = sessionOptions.resume;
        if (resume && resume.agent !== id) throw new AgentError('protocol_error', `[sigx ai-agent-copilot-cli] session ref belongs to agent "${resume.agent}", not "${id}"`);
        if (sessionOptions.fork) throw new AgentError('protocol_error', '[sigx ai-agent-copilot-cli] Copilot sessions cannot be forked');
        const conn = await connect();
        // A bring-your-own-key session runs without a GitHub login; everything else needs one.
        if (!conn.authenticated && !sessionOptions.provider) throw notSignedIn();
        const tools: readonly AnyTool[] = sessionOptions.tools ?? [];
        const sessionId = resume ? resume.id : `cp_${Math.random().toString(36).slice(2, 14)}`;
        const epoch = resume ? ((resume.data as { epoch?: number } | undefined)?.epoch ?? 1) + 1 : 1;
        const models: readonly ConfigValue[] = options.models ?? toModelValues(conn.models);
        const session = createCopilotSession({
            agentId: id,
            sessionId,
            cwd: sessionOptions.cwd,
            tools,
            options: sessionOptions,
            models,
            modelInfos: conn.models,
            epoch,
            errorSettleMs: options.errorSettleMs ?? DEFAULT_ERROR_SETTLE_MS,
            onClose: (closedId) => {
                sessions.delete(closedId);
            }
        });
        const config: SessionConfig = {
            ...toSessionConfig(sessionOptions),
            ...(tools.length ? { tools: session.hooks.tools } : {}),
            onEvent: session.hooks.onEvent,
            onPermissionRequest: session.hooks.onPermissionRequest,
            onUserInputRequest: session.hooks.onUserInputRequest
        };
        sessions.set(sessionId, session);
        try {
            const sdk = resume ? await conn.client.resumeSession(sessionId, config) : await conn.client.createSession({ ...config, sessionId });
            session.attach(sdk);
        } catch (e) {
            sessions.delete(sessionId);
            await session.close().catch(() => {});
            if (e instanceof AgentError) throw e;
            throw new AgentError('provider_error', `[sigx ai-agent-copilot-cli] the runtime refused the session: ${e instanceof Error ? e.message : String(e)}`, false, { cause: e });
        }
        return session;
    }

    return {
        id,
        capabilities: COPILOT_CLI_CAPABILITIES,
        session: openSession,
        async listSessions(): Promise<SessionSummary[]> {
            const conn = await connect();
            const list = await conn.client.listSessions();
            return list.map((s) => ({
                ref: { agent: id, v: 1, id: s.sessionId, ...(s.context?.workingDirectory ? { data: { cwd: s.context.workingDirectory } } : {}) },
                ...(s.summary ? { title: s.summary } : {}),
                ...(s.modifiedTime ? { updatedAt: new Date(s.modifiedTime).getTime() } : {})
            }));
        },
        async dispose() {
            disposed = true;
            const pending = connecting;
            connecting = undefined;
            await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})));
            if (!pending) return;
            const conn = await pending.catch(() => undefined);
            if (conn?.owned) await conn.client.stop().catch(() => {});
        }
    };
}

/** The SDK client for these options; the SDK is loaded on first use so a missing peer is a thrown `AgentError`, not a crash at import. */
async function createClient(options: CopilotCliOptions): Promise<CopilotClientLike> {
    let sdk: typeof import('@github/copilot-sdk');
    try {
        sdk = await import('@github/copilot-sdk');
    } catch (e) {
        throw new AgentError('protocol_error', '[sigx ai-agent-copilot-cli] @github/copilot-sdk is not installed — `npm i @github/copilot-sdk` (it bundles the Copilot CLI runtime)', false, { cause: e });
    }
    const clientOptions: CopilotClientOptions = {
        connection: sdk.RuntimeConnection.forStdio(options.cliPath !== undefined ? { path: options.cliPath } : {}),
        ...toClientOptions(options)
    };
    return new sdk.CopilotClient(clientOptions);
}

function notSignedIn(): AgentError {
    return new AgentError('auth_required', '[sigx ai-agent-copilot-cli] Copilot is not signed in — run `copilot login` (or set COPILOT_GITHUB_TOKEN / GH_TOKEN, or pass `gitHubToken`) and retry', false, {
        data: { hint: 'copilot login' }
    });
}
