/**
 * The production entry. Three handlers in a chain:
 *
 *   serverFns (the chat stream) → built assets → the SSR document
 *
 * Importing the build's registry also evaluates the server-only modules, so
 * the model client exists before the first request.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { createServerFnHandler } from '@sigx/server/node';
import { createRequestHandler } from '@sigx/server-renderer/node';

const here = import.meta.dirname;
const clientDir = join(here, 'dist/client');
const assetsDir = join(clientDir, 'assets');

const { createApp } = await import('./dist/server/entry-server.js');
const { serverFns } = await import('./dist/server/sigx-server-fns.js');

const PORT = Number(process.env.PORT ?? 5310);

const template = await readFile(join(clientDir, 'index.html'), 'utf8');
const fns = createServerFnHandler({ functions: serverFns });
const document = createRequestHandler({ template, app: (url) => createApp(url) });

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.map': 'application/json' };

async function serveAsset(req, res, next) {
    let pathname = '/';
    try {
        ({ pathname } = new URL(req.url ?? '/', 'http://localhost'));
    } catch {
        return next();
    }
    if (!pathname.startsWith('/assets/')) return next();
    // Join the RELATIVE remainder onto the assets dir (a leading slash is
    // dropped so the intent is unambiguous), then normalize; anything that
    // escapes the directory is a 404, never a read.
    const file = normalize(join(assetsDir, decodeURIComponent(pathname.slice('/assets/'.length))));
    if (file !== assetsDir && !file.startsWith(assetsDir + sep)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return void res.end('not found');
    }
    let body;
    try {
        body = await readFile(file);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return void res.end('not found');
    }
    res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable'
    });
    res.end(body);
}

createServer((req, res) => {
    fns(req, res, () => void serveAsset(req, res, () => document(req, res)));
}).listen(PORT, () => {
    console.log(`chat  http://localhost:${PORT}`);
});
