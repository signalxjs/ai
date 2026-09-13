/**
 * @sigx/ai-agent-codex — Codex as an `Agent`, over the `codex app-server`
 * JSON-RPC protocol (threads, turns, approvals, dynamic client tools).
 *
 * One app-server process and one JSON-RPC peer per agent, started lazily on
 * the first session; a session is a thread. The adapter never collects or
 * stores credentials — Codex's own login is the user's business, and only
 * the env allowlist reaches the child.
 */

import type { AnyTool } from '@sigx/ai';
import type { Agent, AgentCapabilities, SessionSummary } from '@sigx/ai-agent';
import { AgentError, capabilities } from '@sigx/ai-agent';
import { createJsonRpcPeer, type JsonRpcPeer } from '@sigx/ai-agent/harness';
import { DEFAULT_ENV_ALLOWLIST, resolveExecutable, spawnAgentProcess, type AgentProcess } from '@sigx/ai-agent-node';
import { DEFAULT_PASS_ENV, type CodexOptions, type CodexSessionOptions } from './options.js';
import { CODEX_METHODS } from './schema.js';
import type {
    AccountReadResponse,
    GetAuthStatusResponse,
    InitializeParams,
    InitializeResponse,
    ModelListResponse,
    ThreadForkParams,
    ThreadListResponse,
    ThreadResumeParams,
    ThreadStartParams,
    ThreadStartResponse
} from './schema.js';
import { createCodexSession, type CodexSession } from './session.js';
import { toDynamicTools } from './tools.js';

export const CODEX_CAPABILITIES: AgentCapabilities = capabilities({
    resume: 'local',
    fork: true,
    cancel: true,
    config: true,
    structuredOutput: true,
    promptParts: 'text+image',
    tools: 'native',
    permissions: 'harness-filtered',
    listSessions: true
});

export const DEFAULT_CODEX_COMMAND = 'codex';
export const DEFAULT_CODEX_ARGS: readonly string[] = ['app-server'];

interface Connection {
    readonly peer: JsonRpcPeer;
    readonly process?: AgentProcess;
    readonly info: InitializeResponse;
    readonly models: { readonly id: string; readonly label?: string }[];
}

export interface CodexAgent extends Agent<CodexSessionOptions> {
    readonly capabilities: AgentCapabilities;
}

export function codex(options: CodexOptions = {}): CodexAgent {
    const id = options.id ?? 'codex';
    const sessions = new Map<string, CodexSession>();
    let connecting: Promise<Connection> | undefined;
    let disposed = false;

    const connect = (): Promise<Connection> => {
        if (disposed) return Promise.reject(new AgentError('protocol_error', `[sigx ai-agent-codex] agent "${id}" is disposed`));
        return (connecting ??= (async () => {
            let process: AgentProcess | undefined;
            let transport = options.transport && options.transport !== 'stdio' ? options.transport : undefined;
            if (!transport) {
                const exe = await resolveExecutable(options.command ?? DEFAULT_CODEX_COMMAND, options.cwd ? { cwd: options.cwd } : {});
                process = spawnAgentProcess({
                    command: exe.command,
                    args: [...exe.args, ...(options.args ?? DEFAULT_CODEX_ARGS)],
                    ...(options.cwd ? { cwd: options.cwd } : {}),
                    env: { ...exe.env, ...options.env },
                    allowEnv: [...DEFAULT_ENV_ALLOWLIST, ...(options.passEnv ?? DEFAULT_PASS_ENV)],
                    kind: exe.kind
                });
                await process.spawned;
                transport = { readable: process.readable, writable: process.writable };
            }
            const peer = createJsonRpcPeer({ readable: transport.readable, writable: transport.writable, cancelMethod: null });
            // Route everything the server sends to the thread it belongs to.
            peer.onUnhandled((message) => {
                const params = (message.params ?? {}) as { threadId?: string; turnId?: string } & Record<string, unknown>;
                if (message.id !== undefined) return; // requests have their own handlers
                if (params.threadId !== undefined) sessions.get(params.threadId)?.handleNotification(message.method, params);
                else for (const s of sessions.values()) s.handleNotification(message.method, params);
            });
            for (const method of [CODEX_METHODS.commandApproval, CODEX_METHODS.fileChangeApproval, CODEX_METHODS.permissionsApproval, CODEX_METHODS.userInput, CODEX_METHODS.toolCall]) {
                peer.onRequest(method, (params: { threadId?: string }, ctx) => {
                    const session = params.threadId !== undefined ? sessions.get(params.threadId) : undefined;
                    if (!session) throw new AgentError('protocol_error', `[sigx ai-agent-codex] "${method}" for unknown thread "${String(params.threadId)}"`);
                    return session.handleRequest(method, params, ctx);
                });
            }
            void peer.closed.then((why) => {
                const tail = process?.stderrTail() ?? '';
                const message = `[sigx ai-agent-codex] the app-server connection closed (${why.reason})${why.error ? `: ${why.error.message}` : ''}${tail ? `\n${tail}` : ''}`;
                for (const s of sessions.values()) s.peerClosed(message);
            });
            const clientInfo = options.clientInfo ?? { name: '@sigx/ai-agent-codex', version: '0.1.0' };
            const init: InitializeParams = { clientInfo: { name: clientInfo.name, title: clientInfo.title ?? null, version: clientInfo.version }, capabilities: { experimentalApi: true, requestAttestation: false } };
            const info = await peer.request<InitializeResponse>(CODEX_METHODS.initialize, init);
            await peer.notify(CODEX_METHODS.initialized, {});
            await assertSignedIn(peer);
            const models = await listModels(peer);
            return { peer, ...(process ? { process } : {}), info, models };
        })().catch((e: unknown) => {
            connecting = undefined;
            throw e;
        }));
    };

    async function openSession(sessionOptions: CodexSessionOptions): Promise<CodexSession> {
        if (!sessionOptions?.cwd) throw new AgentError('protocol_error', '[sigx ai-agent-codex] session options need a cwd');
        const conn = await connect();
        const tools: readonly AnyTool[] = sessionOptions.tools ?? [];
        const strict = sessionOptions.policy !== undefined;
        const common: ThreadStartParams = {
            cwd: sessionOptions.cwd,
            ...(sessionOptions.model !== undefined ? { model: sessionOptions.model } : {}),
            approvalPolicy: sessionOptions.approvalPolicy ?? (strict ? 'untrusted' : 'on-request'),
            sandbox: sessionOptions.sandbox ?? (strict ? 'workspace-write' : 'workspace-write'),
            ...(sessionOptions.system !== undefined ? { baseInstructions: sessionOptions.system } : {}),
            ...(tools.length ? { dynamicTools: toDynamicTools(tools) } : {})
        };
        let thread: ThreadStartResponse;
        let epoch = 1;
        if (sessionOptions.resume) {
            if (sessionOptions.resume.agent !== id) throw new AgentError('protocol_error', `[sigx ai-agent-codex] session ref belongs to agent "${sessionOptions.resume.agent}", not "${id}"`);
            const params: ThreadResumeParams | ThreadForkParams = { ...common, threadId: sessionOptions.resume.id };
            thread = await conn.peer.request<ThreadStartResponse>(sessionOptions.fork ? CODEX_METHODS.threadFork : CODEX_METHODS.threadResume, params);
            if (!sessionOptions.fork) epoch = ((sessionOptions.resume.data as { epoch?: number } | undefined)?.epoch ?? 1) + 1;
        } else {
            thread = await conn.peer.request<ThreadStartResponse>(CODEX_METHODS.threadStart, common);
        }
        const session = createCodexSession({
            agentId: id,
            peer: conn.peer,
            // `turn/interrupt`; errors are swallowed — the turn then completes as `interrupted` (or already has).
            interrupt: (threadId, turnId) => conn.peer.request(CODEX_METHODS.turnInterrupt, { threadId, turnId }).then(() => undefined, () => undefined),
            thread,
            cwd: sessionOptions.cwd,
            tools,
            options: sessionOptions,
            models: conn.models,
            epoch,
            onClose: (threadId) => {
                sessions.delete(threadId);
            }
        });
        sessions.set(session.threadId, session);
        return session;
    }

    return {
        id,
        capabilities: CODEX_CAPABILITIES,
        session: openSession,
        async listSessions(): Promise<SessionSummary[]> {
            const conn = await connect();
            const out: SessionSummary[] = [];
            let cursor: string | null = null;
            do {
                const page: ThreadListResponse = await conn.peer.request<ThreadListResponse>(CODEX_METHODS.threadList, cursor ? { cursor } : {});
                for (const t of page.data) {
                    out.push({
                        ref: { agent: id, v: 1, id: t.id, ...(t.cwd ? { data: { cwd: t.cwd } } : {}) },
                        ...(t.preview ? { title: t.preview } : {}),
                        ...(typeof t.updatedAt === 'number' ? { updatedAt: t.updatedAt * 1000 } : {})
                    });
                }
                cursor = page.nextCursor;
            } while (cursor);
            return out;
        },
        async dispose() {
            disposed = true;
            const pending = connecting;
            connecting = undefined;
            await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})));
            if (!pending) return;
            const conn = await pending.catch(() => undefined);
            if (!conn) return;
            await conn.peer.close().catch(() => {});
            await conn.process?.kill().catch(() => {});
        }
    };
}

/** `account/read` first (shape UNVERIFIED beyond `account`), `getAuthStatus` as the fallback; only a positive "not signed in" throws. */
async function assertSignedIn(peer: JsonRpcPeer): Promise<void> {
    try {
        const read = await peer.request<AccountReadResponse>(CODEX_METHODS.accountRead, {});
        if (read && typeof read === 'object' && 'account' in read) {
            if (read.account === null) throw notSignedIn();
            return;
        }
    } catch (e) {
        if (e instanceof AgentError) throw e;
    }
    try {
        const status = await peer.request<GetAuthStatusResponse>(CODEX_METHODS.getAuthStatus, { includeToken: false, refreshToken: false });
        if (status && status.authMethod === null && status.requiresOpenaiAuth !== false) throw notSignedIn();
    } catch (e) {
        if (e instanceof AgentError) throw e;
        // An older server without the method: proceed and let the first turn tell.
    }
}

function notSignedIn(): AgentError {
    return new AgentError('auth_required', '[sigx ai-agent-codex] Codex is not signed in — run `codex login` (or set OPENAI_API_KEY) and retry', false, {
        data: { hint: 'codex login' }
    });
}

async function listModels(peer: JsonRpcPeer): Promise<{ readonly id: string; readonly label?: string }[]> {
    try {
        const page = await peer.request<ModelListResponse>(CODEX_METHODS.modelList, {});
        return page.data.filter((m) => !m.hidden).map((m) => ({ id: m.model, ...(m.displayName ? { label: m.displayName } : {}) }));
    } catch {
        return [];
    }
}
