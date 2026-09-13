// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { defineTool, type StandardSchemaV1 } from '@sigx/ai';
import { createMcpToolHandler } from '@sigx/ai-agent/harness';
import { listenMcp } from '@sigx/ai-agent-node';

const anySchema: StandardSchemaV1<unknown, unknown> = { '~standard': { version: 1, vendor: 'test', validate: (v) => ({ value: v }) } };
const echo = defineTool({ name: 'echo', description: 'Echo.', input: anySchema, jsonSchema: { type: 'object' }, execute: (i) => ({ echoed: i }) });

const rpc = (method: string, params?: unknown, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

describe('listenMcp', () => {
    it('serves the MCP tool handler on loopback behind a bearer token', async () => {
        const listener = await listenMcp(createMcpToolHandler([echo], { name: 't', version: '1' }));
        try {
            expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
            expect(listener.token).toHaveLength(64);
            expect(listener.headers).toEqual({ Authorization: `Bearer ${listener.token}` });

            const unauthorized = await fetch(listener.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc('ping') });
            expect(unauthorized.status).toBe(401);
            expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
            const wrong = await fetch(listener.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${'0'.repeat(64)}` }, body: rpc('ping') });
            expect(wrong.status).toBe(401);
            const notFound = await fetch(listener.url.replace('/mcp', '/other'), { method: 'POST', headers: listener.headers });
            expect(notFound.status).toBe(404);

            const headers = { ...listener.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
            const init = await fetch(listener.url, { method: 'POST', headers, body: rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } }) });
            expect(init.status).toBe(200);
            expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('t');
            const call = await fetch(listener.url, { method: 'POST', headers, body: rpc('tools/call', { name: 'echo', arguments: { a: 1 } }, 2) });
            const body = (await call.json()) as { result: { structuredContent: unknown; isError?: boolean } };
            expect(body.result.structuredContent).toEqual({ echoed: { a: 1 } });
            expect(body.result.isError).toBeUndefined();
        } finally {
            await listener.close();
        }
        await expect(fetch(listener.url, { method: 'POST', headers: listener.headers })).rejects.toThrow();
    });

    it('honours a caller token and path', async () => {
        const listener = await listenMcp(async () => new Response('ok'), { token: 'fixed-token', path: '/tools' });
        try {
            expect(listener.url.endsWith('/tools')).toBe(true);
            const res = await fetch(listener.url, { method: 'POST', headers: { authorization: 'Bearer fixed-token' }, body: '{}' });
            expect(res.status).toBe(200);
            expect(await res.text()).toBe('ok');
        } finally {
            await listener.close();
        }
    });
});
