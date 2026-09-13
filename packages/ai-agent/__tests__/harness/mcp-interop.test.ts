/**
 * Interoperability: the official MCP TypeScript client (a devDependency only)
 * driving `createMcpToolHandler` through its Streamable HTTP transport, with
 * `fetch` routed straight to the handler.
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { defineTool, type StandardSchemaV1 } from '@sigx/ai';
import { createMcpToolHandler } from '@sigx/ai-agent/harness';

let sdk: { Client: new (info: { name: string; version: string }) => any; StreamableHTTPClientTransport: new (url: URL, opts?: Record<string, unknown>) => any } | undefined;
let reason = '';
try {
    const [client, transport] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js')]);
    sdk = { Client: client.Client as never, StreamableHTTPClientTransport: transport.StreamableHTTPClientTransport as never };
} catch (e) {
    reason = `@modelcontextprotocol/sdk not available: ${e instanceof Error ? e.message : String(e)}`;
    console.log(`skipping MCP interop: ${reason}`);
}

const anySchema: StandardSchemaV1<{ city: string }, { city: string }> = { '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value: value as { city: string } }) } };
const weather = defineTool({ name: 'weather', description: 'Weather for a city', input: anySchema, jsonSchema: { type: 'object', properties: { city: { type: 'string' } } }, execute: ({ city }) => ({ city, tempC: 21 }) });

describe.skipIf(!sdk)('MCP interop (official client → createMcpToolHandler)', () => {
    it('initializes, lists and calls tools over Streamable HTTP with a bearer token', async () => {
        const token = 'tok-123';
        const handler = createMcpToolHandler([weather], { name: 'interop', version: '0.0.1', auth: (r) => r.headers.get('authorization') === `Bearer ${token}` });
        const seen: string[] = [];
        const fetchToHandler = async (input: string | URL | Request, init?: RequestInit) => {
            const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
            seen.push(request.method);
            return handler(request);
        };
        const transport = new sdk!.StreamableHTTPClientTransport(new URL('http://127.0.0.1:1/mcp'), {
            fetch: fetchToHandler,
            requestInit: { headers: { authorization: `Bearer ${token}` } }
        });
        const client = new sdk!.Client({ name: 'interop-test', version: '0.0.1' });
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((t: { name: string }) => t.name)).toEqual(['weather']);
        const result = await client.callTool({ name: 'weather', arguments: { city: 'Oslo' } });
        expect(result.structuredContent).toEqual({ city: 'Oslo', tempC: 21 });
        expect(result.content).toEqual([{ type: 'text', text: '{"city":"Oslo","tempC":21}' }]);
        await client.close();
        expect(seen.every((m) => m === 'POST' || m === 'GET' || m === 'DELETE')).toBe(true);
    });
});
