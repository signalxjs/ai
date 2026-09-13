/**
 * `listenMcp` — serve a `(Request) => Promise<Response>` handler (the MCP
 * tool handler from `@sigx/ai-agent/harness`) on a loopback `node:http`
 * server, behind a bearer token. A harness process on the same machine
 * connects to `url` with `headers`; nothing else can, and nothing leaves the
 * machine.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

export interface ListenMcpOptions {
    /** Default `127.0.0.1` — loopback only. */
    readonly host?: string;
    /** Default `0` (an ephemeral port). */
    readonly port?: number;
    /** Default `/mcp`. */
    readonly path?: string;
    /** Default: 32 random bytes, hex. */
    readonly token?: string;
}

export interface McpListener {
    readonly url: string;
    readonly token: string;
    /** The header a client sends: `{ Authorization: 'Bearer <token>' }`. */
    readonly headers: { readonly Authorization: string };
    readonly server: Server;
    close(): Promise<void>;
}

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokenMatches(header: string | undefined, token: string): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const presented = Buffer.from(header.slice(7), 'utf8');
    const expected = Buffer.from(token, 'utf8');
    return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
}

/** An `IncomingMessage` as a fetch `Request`. */
export function toRequest(req: IncomingMessage, base: string): Request {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) headers.append(k, item);
        else headers.set(k, v);
    }
    const method = req.method ?? 'GET';
    const init: RequestInit & { duplex?: 'half' } = { method, headers };
    if (!BODYLESS.has(method)) {
        init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        init.duplex = 'half';
    }
    return new Request(new URL(req.url ?? '/', base), init);
}

/** Write a fetch `Response` to a `ServerResponse`. */
export async function sendResponse(response: Response, res: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
        const existing = headers[key];
        headers[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    });
    res.writeHead(response.status, headers);
    if (!response.body) {
        res.end();
        return;
    }
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', () => resolve()));
        }
    } finally {
        res.end();
    }
}

export function listenMcp(handler: (request: Request) => Promise<Response>, options: ListenMcpOptions = {}): Promise<McpListener> {
    const host = options.host ?? '127.0.0.1';
    const path = options.path ?? '/mcp';
    const token = options.token ?? randomBytes(32).toString('hex');

    // An IPv6 host needs brackets in a URL (`http://[::1]`).
    const base = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`;
    const server = createServer((req, res) => {
        void (async () => {
            try {
                const url = new URL(req.url ?? '/', base);
                if (url.pathname !== path) {
                    res.writeHead(404).end();
                    return;
                }
                if (!tokenMatches(req.headers.authorization, token)) {
                    res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
                    return;
                }
                const response = await handler(toRequest(req, base));
                await sendResponse(response, res);
            } catch (e) {
                if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
                res.end(e instanceof Error ? e.message : String(e));
            }
        })();
    });

    return new Promise<McpListener>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, host, () => {
            server.off('error', reject);
            const address = server.address() as AddressInfo;
            const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address;
            resolve({
                url: `http://${hostname}:${address.port}${path}`,
                token,
                headers: { Authorization: `Bearer ${token}` },
                server,
                close: () =>
                    new Promise<void>((done, fail) => {
                        server.closeAllConnections?.();
                        server.close((e) => (e ? fail(e) : done()));
                    })
            });
        });
    });
}
