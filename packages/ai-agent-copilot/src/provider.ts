/**
 * `copilot()` — GitHub Copilot CLI as an `Agent`, on the official
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
import type { CopilotClientLike, CopilotOptions, CopilotSessionOptions } from './options.js';
import { toModelValues, toSessionConfig } from './request.js';
import { createCopilotSession, type CopilotSession } from './session.js';

export const COPILOT_CAPABILITIES: AgentCapabilities = capabilities({
    resume: 'local',
    fork: false,
    cancel: true,
    // A prompt during a turn is queued by the runtime and starts its own turn — not steering.
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

export interface CopilotAgent extends Agent<CopilotSessionOptions> {
    listSessions(): Promise<SessionSummary[]>;
}

export function copilot(options: CopilotOptions = {}): CopilotAgent {
    const id = options.id ?? 'copilot';
    const sessions = new Map<string, CopilotSession>();
    let connecting: Promise<Connection> | undefined;
    let disposed = false;

    const connect = (): Promise<Connection> => {
        if (disposed) return Promise.reject(new AgentError('protocol_error', `[sigx ai-agent-copilot] agent "${id}" is disposed`));
        return (connecting ??= (async () => {
            const client = options.client ?? (await createClient(options));
            try {
                await client.start();
            } catch (e) {
                throw new AgentError('process_exited', `[sigx ai-agent-copilot] the Copilot runtime did not start: ${e instanceof Error ? e.message : String(e)}`, false, { cause: e });
            }
            const status = await client.getAuthStatus().catch(() => ({ isAuthenticated: false }));
            const models = status.isAuthenticated ? await client.listModels().catch((): ModelInfo[] => []) : [];
            return { client, owned: !options.client, authenticated: status.isAuthenticated, models };
        })().catch((e: unknown) => {
            connecting = undefined;
            throw e;
        }));
    };

    async function openSession(sessionOptions: CopilotSessionOptions): Promise<CopilotSession> {
        if (!sessionOptions?.cwd) throw new AgentError('protocol_error', '[sigx ai-agent-copilot] session options need a cwd');
        const resume = sessionOptions.resume;
        if (resume && resume.agent !== id) throw new AgentError('protocol_error', `[sigx ai-agent-copilot] session ref belongs to agent "${resume.agent}", not "${id}"`);
        if (sessionOptions.fork) throw new AgentError('protocol_error', '[sigx ai-agent-copilot] Copilot sessions cannot be forked');
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
            throw new AgentError('provider_error', `[sigx ai-agent-copilot] the runtime refused the session: ${e instanceof Error ? e.message : String(e)}`, false, { cause: e });
        }
        return session;
    }

    return {
        id,
        capabilities: COPILOT_CAPABILITIES,
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
async function createClient(options: CopilotOptions): Promise<CopilotClientLike> {
    let sdk: typeof import('@github/copilot-sdk');
    try {
        sdk = await import('@github/copilot-sdk');
    } catch (e) {
        throw new AgentError('protocol_error', '[sigx ai-agent-copilot] @github/copilot-sdk is not installed — `npm i @github/copilot-sdk` (it bundles the Copilot CLI runtime)', false, { cause: e });
    }
    const clientOptions: CopilotClientOptions = {
        connection: sdk.RuntimeConnection.forStdio(options.cliPath !== undefined ? { path: options.cliPath } : {}),
        ...(options.env ? { env: { ...options.env } } : {}),
        ...(options.cwd !== undefined ? { workingDirectory: options.cwd } : {}),
        ...(options.baseDirectory !== undefined ? { baseDirectory: options.baseDirectory } : {}),
        ...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
        ...(options.gitHubToken !== undefined ? { gitHubToken: options.gitHubToken } : {}),
        ...(options.useLoggedInUser !== undefined ? { useLoggedInUser: options.useLoggedInUser } : {}),
        clientInfo: { integrationName: '@sigx/ai-agent-copilot', applicationVersion: '0.1.0' }
    };
    return new sdk.CopilotClient(clientOptions);
}

function notSignedIn(): AgentError {
    return new AgentError('auth_required', '[sigx ai-agent-copilot] Copilot is not signed in — run `copilot login` (or set COPILOT_GITHUB_TOKEN / GH_TOKEN, or pass `gitHubToken`) and retry', false, {
        data: { hint: 'copilot login' }
    });
}
