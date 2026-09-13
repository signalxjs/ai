/**
 * Client tools reach Claude Code the way they reach every MCP-capable harness:
 * `createMcpToolHandler` served on a loopback listener, passed to the CLI as
 * an HTTP MCP server with a per-session bearer token.
 */

import { timingSafeEqual } from 'node:crypto';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AnyTool } from '@sigx/ai';
import { createMcpToolHandler } from '@sigx/ai-agent/harness';
import type { ListenFn } from './options.js';

/** The bearer token of an `Authorization` header — scheme case-insensitive, whitespace tolerated. */
export function bearerToken(header: string | null): string | undefined {
    const m = header ? /^\s*bearer\s+(\S+)\s*$/i.exec(header) : null;
    return m ? m[1] : undefined;
}

export function sameToken(a: string | undefined, b: string): boolean {
    if (a === undefined) return false;
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

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
        auth: (request) => sameToken(bearerToken(request.headers.get('authorization')), token)
    });
    const listener = await options.listen(handler);
    token = listener.token;
    return {
        name: options.name,
        config: { type: 'http', url: listener.url, headers: { ...listener.headers } },
        close: () => listener.close()
    };
}
