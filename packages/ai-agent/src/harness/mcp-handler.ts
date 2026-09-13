/**
 * `createMcpToolHandler` — client tools as an MCP server, the way every
 * MCP-capable harness reaches them: a `(Request) => Promise<Response>` for
 * the Streamable HTTP transport, tools only.
 *
 * JSON-only and stateless on purpose: `tools/call` is strictly request →
 * response and this server never initiates a message, so SSE buys nothing;
 * the tool set is fixed for a session's lifetime, so no `Mcp-Session-Id`.
 * The official client accepts `application/json` responses. Authentication
 * is a per-request hook (a bearer token the host minted per session).
 */

import { SchemaValidationError, type AnyTool } from '@sigx/ai';
import { JSON_RPC } from './json-rpc.js';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];

export interface McpToolHandlerOptions {
    readonly name: string;
    readonly version: string;
    readonly instructions?: string;
    /** Per-request check (typically the bearer token); returning `false` → 401 with `WWW-Authenticate: Bearer`. */
    readonly auth?: (request: Request) => boolean | Promise<boolean>;
    /** When set, a request with an `Origin` outside this list → 403. */
    readonly allowedOrigins?: readonly string[];
    /** Advertised on `initialize`; default `MCP_PROTOCOL_VERSION`. */
    readonly protocolVersion?: string;
}

export type McpToolHandler = (request: Request) => Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const rpcError = (id: unknown, code: number, message: string, status = 200) => json(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createMcpToolHandler(tools: readonly AnyTool[], options: McpToolHandlerOptions): McpToolHandler {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const protocolVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;

    return async (request) => {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
        if (options.auth && !(await options.auth(request))) {
            return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
        }
        const origin = request.headers.get('origin');
        if (options.allowedOrigins && origin !== null && !options.allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
        const contentType = request.headers.get('content-type') ?? '';
        if (!/^application\/json\b/i.test(contentType)) return new Response(null, { status: 415 });
        const version = request.headers.get('mcp-protocol-version');
        if (version !== null && !MCP_SUPPORTED_VERSIONS.includes(version)) {
            return rpcError(null, JSON_RPC.INVALID_REQUEST, `Unsupported MCP protocol version: ${version} (supported: ${MCP_SUPPORTED_VERSIONS.join(', ')})`, 400);
        }

        let message: unknown;
        try {
            message = await request.json();
        } catch {
            return rpcError(null, JSON_RPC.PARSE_ERROR, 'Parse error', 400);
        }
        if (Array.isArray(message)) return rpcError(null, JSON_RPC.INVALID_REQUEST, 'Batch requests are not supported', 400);
        if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return rpcError(null, JSON_RPC.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request', 400);
        }
        const { id, method } = message;
        const params = isPlainObject(message.params) ? message.params : {};

        // A notification has no `id` at all; an `id` of the wrong type is a malformed
        // request, answered so a client never waits on it.
        if (!('id' in message)) return new Response(null, { status: 202 });
        if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, JSON_RPC.INVALID_REQUEST, 'Invalid request id', 400);

        switch (method) {
            case 'initialize': {
                const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
                return json(200, {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: requested !== undefined && MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : protocolVersion,
                        capabilities: { tools: {} },
                        serverInfo: { name: options.name, version: options.version },
                        ...(options.instructions !== undefined ? { instructions: options.instructions } : {})
                    }
                });
            }
            case 'ping':
                return json(200, { jsonrpc: '2.0', id, result: {} });
            case 'tools/list':
                return json(200, {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        // Tool annotations (readOnlyHint, …) join once `AnyTool` carries them (signalxjs/ai#37).
                        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.spec.inputSchema }))
                    }
                });
            case 'tools/call': {
                const name = typeof params.name === 'string' ? params.name : '';
                const tool = byName.get(name);
                if (!tool) return rpcError(id, JSON_RPC.INVALID_PARAMS, `Unknown tool: ${name || '(missing name)'}`);
                try {
                    const result = await tool.run(params.arguments ?? {}, { signal: request.signal, toolCallId: String(id) });
                    const text = typeof result === 'string' ? result : JSON.stringify(result === undefined ? null : result);
                    return json(200, {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{ type: 'text', text }],
                            ...(isPlainObject(result) ? { structuredContent: result } : {})
                        }
                    });
                } catch (e) {
                    const text = e instanceof SchemaValidationError ? e.message : e instanceof Error ? e.message : String(e);
                    return json(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
                }
            }
            default:
                return rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
    };
}
