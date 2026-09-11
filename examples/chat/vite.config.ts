/**
 * Two plugins, one build:
 *
 *  - `sigx()`       owns the client/ssr environments and the builder order
 *  - `sigxServer()` extracts `*.server.ts` (the chat `serverStream`) and
 *                   swaps it for a typed stub in the client build — the
 *                   provider SDKs and the API key never reach the browser
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
        // No `serverApp`: the one endpoint is `allowAnonymous`. A real app
        // adds `createServerApp` here for authentication and a rate limiter —
        // a model call costs money on every request.
        sigxServer()
    ]
});
