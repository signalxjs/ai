/**
 * `acp()` — one agent process (or stream pair), one JSON-RPC peer, one
 * `initialize`; sessions on top. Capabilities are honest: they are the
 * conservative set until `initialize` has answered (`connect()`), then
 * whatever the agent advertised.
 */

import { AgentError, capabilities, type Agent, type AgentCapabilities, type AgentSession, type SessionSummary } from '@sigx/ai-agent';
import { createJsonRpcPeer, type JsonRpcPeer } from '@sigx/ai-agent/harness';
import { buildChildEnv, resolveExecutable, spawnAgentProcess, type AgentProcess } from '@sigx/ai-agent-node';
import { registerClientMethods, type AcpSessionRuntime } from './client-methods.js';
import type { AcpOptions, AcpSessionOptions } from './options.js';
import type { AcpInitializeRequest, AcpInitializeResponse, AcpListSessionsResponse } from './schema.js';
import { ACP_METHODS, ACP_PROTOCOL_VERSION } from './schema.js';
import { openAcpSession } from './session.js';

export interface AcpAgent extends Agent<AcpSessionOptions> {
    /** Start the agent (if needed) and run `initialize`; resolves with the negotiated capabilities. Idempotent. */
    connect(): Promise<AgentCapabilities>;
    /** The `initialize` response, once connected. */
    readonly init: AcpInitializeResponse | undefined;
}

/** Before `initialize`: what any ACP agent can do, nothing more. */
export const ACP_BASE_CAPABILITIES: AgentCapabilities = capabilities({ cancel: true, permissions: 'harness-filtered' });

export function capabilitiesFrom(init: AcpInitializeResponse): AgentCapabilities {
    const caps = init.agentCapabilities ?? {};
    const sess = caps.sessionCapabilities ?? {};
    const prompt = caps.promptCapabilities ?? {};
    return capabilities({
        cancel: true,
        permissions: 'harness-filtered',
        resume: sess.resume || caps.loadSession ? 'local' : false,
        fork: !!sess.fork,
        listSessions: !!sess.list,
        promptParts: prompt.image ? (prompt.embeddedContext ? 'text+image+file' : 'text+image') : 'text',
        tools: caps.mcpCapabilities?.http ? 'mcp' : 'none',
        // Modes and config options only show up per session; `configure` is offered regardless.
        config: true
    });
}

export function acp(options: AcpOptions = {}): AcpAgent {
    const id = options.id ?? 'acp';
    const runtimes = new Map<string, AcpSessionRuntime>();
    const sessions = new Set<AgentSession>();
    let caps: AgentCapabilities = ACP_BASE_CAPABILITIES;
    let init: AcpInitializeResponse | undefined;
    let peer: JsonRpcPeer | undefined;
    let proc: AgentProcess | undefined;
    let connecting: Promise<AgentCapabilities> | undefined;
    let disposed = false;

    async function connect(): Promise<AgentCapabilities> {
        if (disposed) throw new AgentError('protocol_error', `[sigx ai-agent-acp] agent "${id}" was disposed`);
        connecting ??= (async () => {
            let streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
            if (options.transport && options.transport !== 'stdio') {
                streams = options.transport;
            } else {
                if (!options.command) throw new AgentError('protocol_error', `[sigx ai-agent-acp] acp() needs a command to spawn (or a transport)`);
                const exe = await resolveExecutable(options.command, { env: process.env, ...(options.cwd ? { cwd: options.cwd } : {}) });
                const passed: Record<string, string> = {};
                for (const name of options.passEnv ?? []) {
                    const v = process.env[name];
                    if (v !== undefined) passed[name] = v;
                }
                proc = spawnAgentProcess({
                    command: exe.command,
                    args: [...exe.args, ...(options.args ?? [])],
                    ...(options.cwd ? { cwd: options.cwd } : {}),
                    env: { ...buildChildEnv({ extra: { ...exe.env, ...passed, ...options.env } }) },
                    inheritEnv: false,
                    kind: exe.kind
                });
                await proc.spawned;
                streams = { readable: proc.readable, writable: proc.writable };
                void proc.exited.then((exit) => {
                    if (disposed) return;
                    const tail = exit.stderrTail.trim();
                    for (const r of runtimes.values()) r.emit({ type: 'error', code: 'process_exited', message: `[sigx ai-agent-acp] agent "${id}" exited (code ${exit.code}, signal ${exit.signal})${tail ? `: ${tail.slice(-500)}` : ''}`, recoverable: false });
                });
            }
            // ACP cancels a turn with `session/cancel`, never a JSON-RPC-level cancel notification.
            peer = createJsonRpcPeer({ readable: streams.readable, writable: streams.writable, cancelMethod: null });
            registerClientMethods(peer, {
                sessions: (sessionId) => runtimes.get(sessionId),
                allSessions: () => runtimes.values(),
                ...(options.fs ? { fs: options.fs } : {}),
                ...(options.terminal ? { terminal: true } : {})
            });
            void peer.closed.then((why) => {
                if (disposed || why.reason === 'closed') return;
                for (const r of runtimes.values()) r.emit({ type: 'error', code: 'process_exited', message: `[sigx ai-agent-acp] the connection to agent "${id}" ended (${why.reason})${why.error ? `: ${why.error.message}` : ''}`, recoverable: false });
            });
            const request: AcpInitializeRequest = {
                protocolVersion: ACP_PROTOCOL_VERSION,
                clientCapabilities: {
                    ...(options.fs?.read || options.fs?.write ? { fs: { ...(options.fs.read ? { readTextFile: true } : {}), ...(options.fs.write ? { writeTextFile: true } : {}) } } : {}),
                    ...(options.terminal ? { terminal: true } : {})
                },
                clientInfo: options.clientInfo ?? { name: '@sigx/ai-agent-acp', version: '0.1.0' }
            };
            init = await peer.request<AcpInitializeResponse>(ACP_METHODS.initialize, request);
            caps = capabilitiesFrom(init);
            return caps;
        })();
        return connecting;
    }

    const agent: AcpAgent = {
        id,
        get capabilities() {
            return caps;
        },
        get init() {
            return init;
        },
        connect,
        async session(sessionOptions) {
            await connect();
            const opened = await openAcpSession({ peer: peer!, agentId: id, init: init!, options, sessionOptions: sessionOptions ?? {}, runtimes });
            const session: AgentSession = {
                ...opened,
                get ref() {
                    return opened.ref;
                },
                async close() {
                    sessions.delete(session);
                    await opened.close();
                }
            };
            sessions.add(session);
            return session;
        },
        async listSessions(): Promise<SessionSummary[]> {
            await connect();
            if (!caps.listSessions) return [];
            const out: SessionSummary[] = [];
            let cursor: string | null | undefined;
            do {
                const page: AcpListSessionsResponse = await peer!.request<AcpListSessionsResponse>(ACP_METHODS.sessionList, cursor ? { cursor } : {});
                for (const s of page.sessions) {
                    const updatedAt = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
                    out.push({
                        ref: { agent: id, v: 1, id: s.sessionId, data: { cwd: s.cwd, epoch: 0 } },
                        ...(s.title ? { title: s.title } : {}),
                        ...(Number.isFinite(updatedAt) ? { updatedAt } : {})
                    });
                }
                cursor = page.nextCursor;
            } while (cursor);
            return out;
        },
        async dispose() {
            disposed = true;
            // Sessions first, while the peer can still say `session/close`: each one
            // ends its log (`state: closed`), kills its terminals and drops its MCP listener.
            await Promise.all([...sessions].map((s) => s.close().catch(() => {})));
            sessions.clear();
            for (const r of runtimes.values()) {
                for (const t of r.terminals.values()) await t.process.kill().catch(() => {});
            }
            runtimes.clear();
            await peer?.close().catch(() => {});
            await proc?.kill().catch(() => {});
        }
    };
    return agent;
}
