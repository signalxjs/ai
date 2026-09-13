/**
 * An in-memory ACP agent: a JSON-RPC peer on the far side of two
 * `TransformStream` pairs, scripted per prompt. Enough of the protocol for
 * the adapter's fixture and conformance tests.
 */
import { createJsonRpcPeer, type JsonRpcPeer, type RequestContext } from '@sigx/ai-agent/harness';
import type {
    AcpAgentCapabilities,
    AcpAuthMethod,
    AcpContentBlock,
    AcpInitializeRequest,
    AcpInitializeResponse,
    AcpNewSessionRequest,
    AcpNewSessionResponse,
    AcpPromptRequest,
    AcpPromptResponse,
    AcpRequestPermissionOutcome,
    AcpRequestPermissionRequest,
    AcpRequestPermissionResponse,
    AcpSessionUpdate,
    AcpToolCall
} from '@sigx/ai-agent-acp';
import { ACP_METHODS, ACP_AUTH_REQUIRED } from '@sigx/ai-agent-acp';
import { JsonRpcError } from '@sigx/ai-agent/harness';

export interface FakePromptApi {
    readonly sessionId: string;
    readonly prompt: AcpContentBlock[];
    readonly signal: AbortSignal;
    /** `true` once the client sent `session/cancel` for this session. */
    readonly cancelled: () => boolean;
    update(update: AcpSessionUpdate): Promise<void>;
    text(text: string, messageId?: string): Promise<void>;
    thought(text: string): Promise<void>;
    toolCall(call: AcpToolCall): Promise<void>;
    permission(request: Omit<AcpRequestPermissionRequest, 'sessionId'>): Promise<AcpRequestPermissionOutcome>;
    readFile(path: string): Promise<{ content: string }>;
    writeFile(path: string, content: string): Promise<void>;
    createTerminal(command: string, args?: string[]): Promise<{ terminalId: string }>;
    terminalOutput(terminalId: string): Promise<{ output: string; truncated: boolean; exitStatus?: { exitCode?: number | null; signal?: string | null } | null }>;
    waitForExit(terminalId: string): Promise<{ exitCode?: number | null; signal?: string | null }>;
    /** Resolves when the client cancels the session (`session/cancel`). */
    untilCancelled(): Promise<void>;
}

export interface FakeAcpOptions {
    readonly capabilities?: AcpAgentCapabilities;
    readonly authMethods?: AcpAuthMethod[];
    /** Reject `session/new` with the auth-required error. */
    readonly requireAuth?: boolean;
    readonly modes?: AcpNewSessionResponse['modes'];
    readonly configOptions?: AcpNewSessionResponse['configOptions'];
    /** What the agent does per prompt (called in order). */
    readonly onPrompt: (api: FakePromptApi, turn: number) => Promise<AcpPromptResponse>;
    /** Updates replayed on `session/load`. */
    readonly history?: AcpSessionUpdate[];
}

export interface FakeAcp {
    readonly transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
    readonly peer: JsonRpcPeer;
    readonly requests: { method: string; params: unknown }[];
    readonly sessions: string[];
    readonly cancels: string[];
    readonly modes: Map<string, string>;
    readonly configValues: Map<string, unknown>;
    close(): Promise<void>;
}

export const FULL_CAPABILITIES: AcpAgentCapabilities = {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true },
    sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {} }
};

export function fakeAcpAgent(options: FakeAcpOptions): FakeAcp {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const peer = createJsonRpcPeer({ readable: toAgent.readable, writable: toClient.writable });
    const requests: { method: string; params: unknown }[] = [];
    const sessions: string[] = [];
    const cancels: string[] = [];
    const modes = new Map<string, string>();
    const configValues = new Map<string, unknown>();
    let sessionSeq = 0;
    let turn = 0;
    const cancelWaiters = new Map<string, (() => void)[]>();
    const record = <P>(method: string) => (params: P) => {
        requests.push({ method, params });
    };

    peer.onRequest<AcpInitializeRequest, AcpInitializeResponse>(ACP_METHODS.initialize, (params) => {
        record(ACP_METHODS.initialize)(params);
        return { protocolVersion: 1, agentCapabilities: options.capabilities ?? FULL_CAPABILITIES, ...(options.authMethods ? { authMethods: options.authMethods } : {}), agentInfo: { name: 'fake-acp', version: '0.0.1' } };
    });
    const open = (params: unknown, id?: string): AcpNewSessionResponse => {
        if (options.requireAuth) throw new JsonRpcError(ACP_AUTH_REQUIRED, 'Authentication required');
        const sessionId = id ?? `fake-${++sessionSeq}`;
        sessions.push(sessionId);
        if (options.modes) modes.set(sessionId, options.modes.currentModeId);
        return { sessionId, ...(options.modes ? { modes: options.modes } : {}), ...(options.configOptions ? { configOptions: options.configOptions } : {}) };
    };
    peer.onRequest<AcpNewSessionRequest, AcpNewSessionResponse>(ACP_METHODS.sessionNew, (params) => {
        record(ACP_METHODS.sessionNew)(params);
        return open(params);
    });
    peer.onRequest<{ sessionId: string }, AcpNewSessionResponse>(ACP_METHODS.sessionFork, (params) => {
        record(ACP_METHODS.sessionFork)(params);
        return open(params);
    });
    peer.onRequest<{ sessionId: string }, Omit<AcpNewSessionResponse, 'sessionId'>>(ACP_METHODS.sessionResume, (params) => {
        record(ACP_METHODS.sessionResume)(params);
        const { sessionId: _s, ...rest } = open(params, params.sessionId);
        return rest;
    });
    peer.onRequest<{ sessionId: string }, Omit<AcpNewSessionResponse, 'sessionId'>>(ACP_METHODS.sessionLoad, async (params) => {
        record(ACP_METHODS.sessionLoad)(params);
        const { sessionId: _s, ...rest } = open(params, params.sessionId);
        for (const update of options.history ?? []) await peer.notify(ACP_METHODS.sessionUpdate, { sessionId: params.sessionId, update });
        return rest;
    });
    peer.onRequest(ACP_METHODS.sessionList, (params) => {
        record(ACP_METHODS.sessionList)(params);
        // The second session carries an unparseable timestamp on purpose.
        return { sessions: sessions.map((sessionId, i) => ({ sessionId, cwd: '/repo', title: `Session ${sessionId}`, updatedAt: i === 0 ? '2026-09-13T12:00:00Z' : 'yesterday-ish' })) };
    });
    peer.onRequest<{ sessionId: string }>(ACP_METHODS.sessionClose, (params) => {
        record(ACP_METHODS.sessionClose)(params);
        return null;
    });
    peer.onRequest<{ sessionId: string; modeId: string }>(ACP_METHODS.sessionSetMode, (params) => {
        record(ACP_METHODS.sessionSetMode)(params);
        modes.set(params.sessionId, params.modeId);
        return null;
    });
    peer.onRequest<{ sessionId: string; configId: string; value: unknown }>(ACP_METHODS.sessionSetConfigOption, (params) => {
        record(ACP_METHODS.sessionSetConfigOption)(params);
        configValues.set(params.configId, params.value);
        return null;
    });
    peer.onNotification<{ sessionId: string }>(ACP_METHODS.sessionCancel, (params) => {
        cancels.push(params.sessionId);
        for (const w of cancelWaiters.get(params.sessionId) ?? []) w();
        cancelWaiters.delete(params.sessionId);
    });
    peer.onRequest<AcpPromptRequest, AcpPromptResponse>(ACP_METHODS.sessionPrompt, async (params, ctx: RequestContext) => {
        record(ACP_METHODS.sessionPrompt)(params);
        const { sessionId } = params;
        const before = cancels.length;
        const api: FakePromptApi = {
            sessionId,
            prompt: params.prompt,
            signal: ctx.signal,
            cancelled: () => cancels.slice(before).includes(sessionId),
            update: (update) => peer.notify(ACP_METHODS.sessionUpdate, { sessionId, update }),
            text: (text, messageId) => peer.notify(ACP_METHODS.sessionUpdate, { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) } }),
            thought: (text) => peer.notify(ACP_METHODS.sessionUpdate, { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } }),
            toolCall: (call) => peer.notify(ACP_METHODS.sessionUpdate, { sessionId, update: { sessionUpdate: 'tool_call', ...call } }),
            permission: async (request) => (await peer.request<AcpRequestPermissionResponse>(ACP_METHODS.sessionRequestPermission, { sessionId, ...request })).outcome,
            readFile: (path) => peer.request(ACP_METHODS.fsReadTextFile, { sessionId, path }),
            writeFile: async (path, content) => {
                await peer.request(ACP_METHODS.fsWriteTextFile, { sessionId, path, content });
            },
            createTerminal: (command, args) => peer.request(ACP_METHODS.terminalCreate, { sessionId, command, ...(args ? { args } : {}) }),
            terminalOutput: (terminalId) => peer.request(ACP_METHODS.terminalOutput, { sessionId, terminalId }),
            waitForExit: (terminalId) => peer.request(ACP_METHODS.terminalWaitForExit, { sessionId, terminalId }),
            untilCancelled: () =>
                new Promise<void>((resolve) => {
                    if (cancels.slice(before).includes(sessionId)) return resolve();
                    const list = cancelWaiters.get(sessionId) ?? [];
                    list.push(resolve);
                    cancelWaiters.set(sessionId, list);
                })
        };
        return options.onPrompt(api, turn++);
    });

    return {
        transport: { readable: toClient.readable, writable: toAgent.writable },
        peer,
        requests,
        sessions,
        cancels,
        modes,
        configValues,
        close: () => peer.close()
    };
}
