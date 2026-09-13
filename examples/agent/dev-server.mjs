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

/**
 * One env var, VALIDATED against the values `agent.server.ts` actually
 * understands — the banner must report what the server DID, so an
 * unrecognised value names its fallback instead of being echoed back.
 */
function pick(name, allowed, fallback) {
    const value = process.env[name];
    if (!value) return fallback;
    if (allowed.includes(value)) return value;
    console.warn(`[agent] ${name}=${value} is not one of ${allowed.join(' | ')} — using ${fallback}.`);
    return fallback;
}

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
    // Mirrors `AGENTS` in src/agent.server.ts — this file runs before Vite can load it.
    const agent = pick('SIGX_AI_AGENT', ['sigx', 'claude-code', 'codex', 'acp:gemini', 'acp:cursor', 'acp:claude-code', 'acp:codex'], 'sigx');
    const provider = pick('SIGX_AI_PROVIDER', ['anthropic', 'openai', 'mock'], process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'mock');
    const detail = agent === 'sigx' ? `model: ${provider}` : `cwd: ${process.env.SIGX_AI_CWD ?? process.cwd()}`;
    console.log(`agent dev  http://localhost:${port}  (agent: ${agent}, ${detail})`);
    console.log('            open it in two tabs — the second one replays the same session');
});
