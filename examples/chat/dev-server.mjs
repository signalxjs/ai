/**
 * The dev server: Vite in middleware mode, plus the renderer's dev document
 * handler. `vite.middlewares` already carries the serverFn endpoint —
 * `sigxServer()` mounts it from its own `configureServer` — so the whole
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

const port = Number(process.env.PORT ?? 5310);
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
    const provider = process.env.AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'mock');
    console.log(`chat dev  http://localhost:${port}  (provider: ${provider})`);
});
