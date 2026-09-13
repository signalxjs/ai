/**
 * Client tools reach Claude Code the way they reach every MCP-capable harness:
 * `createMcpToolHandler` served on a loopback listener, passed to the CLI as
 * an HTTP MCP server with a per-session bearer token.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AnyTool } from '@sigx/ai';
import { createMcpToolHandler } from '@sigx/ai-agent/harness';
import type { ListenFn } from './options.js';

export interface ToolServer {
    readonly name: string;
    readonly config: McpServerConfig;
    close(): Promise<void>;
}

export async function startToolServer(tools: readonly AnyTool[], options: { readonly name: string; readonly version: string; readonly listen: ListenFn }): Promise<ToolServer> {
    let token = '';
    const handler = createMcpToolHandler(tools, {
        name: options.name,
        version: options.version,
        auth: (request) => request.headers.get('authorization') === `Bearer ${token}`
    });
    const listener = await options.listen(handler);
    token = listener.token;
    return {
        name: options.name,
        config: { type: 'http', url: listener.url, headers: { ...listener.headers } },
        close: () => listener.close()
    };
}
