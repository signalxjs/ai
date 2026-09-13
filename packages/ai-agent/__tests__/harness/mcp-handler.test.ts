// @vitest-environment node
// (happy-dom's Request drops forbidden headers such as Origin; these are protocol tests.)
import { describe, it, expect } from 'vitest';
import { defineTool, type StandardSchemaV1 } from '@sigx/ai';
import { createMcpToolHandler, MCP_PROTOCOL_VERSION, JSON_RPC, type McpToolHandler } from '@sigx/ai-agent/harness';

const citySchema: StandardSchemaV1<{ city: string }, { city: string }> = {
    '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) =>
            typeof value === 'object' && value !== null && typeof (value as { city?: unknown }).city === 'string' ? { value: value as { city: string } } : { issues: [{ message: 'city must be a string' }] }
    }
};
const weather = defineTool({
    name: 'weather',
    description: 'Weather for a city',
    input: citySchema,
    jsonSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    execute: ({ city }) => ({ city, tempC: city.length })
});
const shout = defineTool({ name: 'shout', description: 'Uppercases', input: citySchema, jsonSchema: { type: 'object' }, execute: ({ city }) => city.toUpperCase() });
const failing = defineTool({
    name: 'failing',
    description: 'Throws',
    input: citySchema,
    jsonSchema: { type: 'object' },
    execute: () => {
        throw new Error('nope');
    }
});

const TOKEN = 'secret-token';
function handler(extra: Partial<Parameters<typeof createMcpToolHandler>[1]> = {}): McpToolHandler {
    return createMcpToolHandler([weather, shout, failing], { name: 'test-tools', version: '1.2.3', auth: (r) => r.headers.get('authorization') === `Bearer ${TOKEN}`, ...extra });
}

function post(body: unknown, headers: Record<string, string> = {}, method = 'POST'): Request {
    return new Request('http://127.0.0.1/mcp', {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    });
}

const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });

describe('createMcpToolHandler', () => {
    it('initialize returns the pinned version, tools capability and server info', async () => {
        const res = await handler({ instructions: 'Be nice.' })(post(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } })));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        expect(await res.json()).toEqual({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-tools', version: '1.2.3' }, instructions: 'Be nice.' }
        });
        const latest = await (await handler()(post(rpc(2, 'initialize', { protocolVersion: '1999-01-01' })))).json();
        expect(latest.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    });

    it('notifications are acknowledged with 202; ping answers {}', async () => {
        expect((await handler()(post({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(202);
        expect(await (await handler()(post(rpc(3, 'ping')))).json()).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    });

    it('a malformed id or a missing jsonrpc version is -32600, never a silent 202', async () => {
        const badId = await handler()(post({ jsonrpc: '2.0', id: null, method: 'ping' }));
        expect(badId.status).toBe(400);
        expect(await badId.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC.INVALID_REQUEST, message: 'Invalid request id' } });
        const objectId = await handler()(post({ jsonrpc: '2.0', id: { nested: true }, method: 'ping' }));
        expect(objectId.status).toBe(400);
        const noVersion = await handler()(post({ id: 1, method: 'ping' }));
        expect(noVersion.status).toBe(400);
        expect((await noVersion.json()).error.code).toBe(JSON_RPC.INVALID_REQUEST);
    });

    it('tools/list exposes name, description and JSON Schema', async () => {
        const body = await (await handler()(post(rpc(4, 'tools/list')))).json();
        expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['weather', 'shout', 'failing']);
        expect(body.result.tools[0]).toEqual({ name: 'weather', description: 'Weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } });
    });

    it('tools/call returns text plus structuredContent for objects, text only for strings', async () => {
        const obj = await (await handler()(post(rpc(5, 'tools/call', { name: 'weather', arguments: { city: 'Oslo' } })))).json();
        expect(obj).toEqual({ jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: '{"city":"Oslo","tempC":4}' }], structuredContent: { city: 'Oslo', tempC: 4 } } });
        const str = await (await handler()(post(rpc(6, 'tools/call', { name: 'shout', arguments: { city: 'oslo' } })))).json();
        expect(str.result).toEqual({ content: [{ type: 'text', text: 'OSLO' }] });
    });

    it('validation errors and tool throws are isError results; unknown tools are -32602', async () => {
        const invalid = await (await handler()(post(rpc(7, 'tools/call', { name: 'weather', arguments: { city: 7 } })))).json();
        expect(invalid.result.isError).toBe(true);
        expect(invalid.result.content[0].text).toMatch(/city must be a string/);
        const thrown = await (await handler()(post(rpc(8, 'tools/call', { name: 'failing', arguments: { city: 'x' } })))).json();
        expect(thrown.result).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
        const unknown = await (await handler()(post(rpc(9, 'tools/call', { name: 'zzz', arguments: {} })))).json();
        expect(unknown).toEqual({ jsonrpc: '2.0', id: 9, error: { code: JSON_RPC.INVALID_PARAMS, message: 'Unknown tool: zzz' } });
    });

    it('rejects: missing token 401, wrong content type 415, GET 405, bad origin 403, bad version 400', async () => {
        const h = handler({ allowedOrigins: ['https://app.example'] });
        const unauth = await h(new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
        expect(unauth.status).toBe(401);
        expect(unauth.headers.get('www-authenticate')).toBe('Bearer');
        expect((await h(post(rpc(1, 'ping'), { 'content-type': 'text/plain' }))).status).toBe(415);
        const get = await h(post(undefined, {}, 'GET'));
        expect(get.status).toBe(405);
        expect(get.headers.get('allow')).toBe('POST');
        expect((await h(post(rpc(1, 'ping'), { origin: 'https://evil.example' }))).status).toBe(403);
        expect((await h(post(rpc(1, 'ping'), { origin: 'https://app.example' }))).status).toBe(200);
        const bad = await h(post(rpc(1, 'ping'), { 'mcp-protocol-version': '2020-01-01' }));
        expect(bad.status).toBe(400);
        expect((await bad.json()).error.message).toMatch(/Unsupported MCP protocol version/);
        expect((await h(post(rpc(1, 'ping'), { 'mcp-protocol-version': '2025-03-26' }))).status).toBe(200);
    });

    it('unknown methods are -32601; batches and invalid JSON are -32600 / -32700', async () => {
        expect(await (await handler()(post(rpc(1, 'resources/list')))).json()).toEqual({ jsonrpc: '2.0', id: 1, error: { code: JSON_RPC.METHOD_NOT_FOUND, message: 'Method not found: resources/list' } });
        const batch = await handler()(post([rpc(1, 'ping')]));
        expect(batch.status).toBe(400);
        expect((await batch.json()).error.code).toBe(JSON_RPC.INVALID_REQUEST);
        const garbage = await handler()(new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{oops' }));
        expect(garbage.status).toBe(400);
        expect((await garbage.json()).error.code).toBe(JSON_RPC.PARSE_ERROR);
    });
});
