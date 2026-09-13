/**
 * Two plugins, one build:
 *
 *  - `sigx()`       owns the client/ssr environments and the builder order
 *  - `sigxServer()` extracts `*.server.ts` (the agent's `serverFn` command
 *                   endpoint and `serverStream` event stream) and swaps it
 *                   for a typed stub in the client build — the agent, the
 *                   policy and the API key never reach the browser
 */
import { defineConfig } from 'vite';
import sigxPlugin from '@sigx/vite';
import { sigxServer } from '@sigx/vite/server';

export default defineConfig({
    // JSX compiles to sigx's runtime, not React's. Vite 8 transforms with
    // oxc, so this is where the import source is declared — tsconfig's
    // `jsxImportSource` only informs the type checker.
    oxc: { jsx: { runtime: 'automatic', importSource: 'sigx' } },
    plugins: [
        sigxPlugin({ ssr: { entry: 'src/entry-server.tsx' } }),
        // No `serverApp`: both endpoints are `allowAnonymous`, and the demo
        // serves ONE process-wide session so a second tab joins it. A real
        // app adds `createServerApp({ authenticate, middleware })` here and
        // keys sessions by principal — see the README.
        sigxServer()
    ]
});
