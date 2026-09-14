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
    // No agent list here any more. This file is plain Node and runs before
    // Vite can load the server module, so it used to mirror `AGENTS` by hand —
    // and a banner that mirrors a list is a banner that eventually lies. The
    // page serves the catalogue instead, so it can just say where to look.
    const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => process.env[k]);
    console.log(`agent dev  http://localhost:${port}  (${keys.length ? `keys: ${keys.join(', ')}` : 'no keys — the scripted agents are always there'})`);
    console.log('            pick an agent, a model and a mode in the sidebar; open several at once to compare them');
});
