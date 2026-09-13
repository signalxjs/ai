/**
 * The dev server: Vite in middleware mode, plus the renderer's dev document
 * handler. `vite.middlewares` already carries the serverFn endpoints —
 * `sigxServer()` mounts them from its own `configureServer` — so the whole
 * composition is: everything Vite answers, then the document for the rest.
 */
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { createDevRequestHandler } from '@sigx/vite/ssr';

const vite = await createViteServer({
    root: import.meta.dirname,
    server: { middlewareMode: true },
    appType: 'custom'
});

const document = await createDevRequestHandler(vite, { entry: '/src/entry-server.tsx' });

const port = Number(process.env.PORT ?? 5320);
createServer((req, res) => {
    vite.middlewares(req, res, () => {
        document(req, res).catch((error) => {
            vite.ssrFixStacktrace(error);
            console.error(error);
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(error?.stack ?? error));
        });
    });
}).listen(port, () => {
    const agent = process.env.AI_AGENT ?? 'sigx';
    const provider = process.env.AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'mock');
    console.log(`agent dev  http://localhost:${port}  (agent: ${agent}${agent === 'sigx' ? `, model: ${provider}` : ''})`);
    console.log('            open it in two tabs — the second one replays the same session');
});
