/**
 * The SSR entry: `createApp(url)` returns a FRESH app per request.
 *
 * `serverPlugin()` is load-bearing beyond configuration: importing
 * `@sigx/server` stamps the request scope the renderer opens around each
 * render, so an in-process server call during SSR sees a real request.
 *
 * Note what the server render does NOT do: `useAgentSession` subscribes on
 * MOUNT, so the document is rendered from an empty transcript and the
 * browser fills it in by replaying the session from `(0, 0)`.
 */
import { defineApp, type App as SigxApp } from 'sigx';
import { serverPlugin } from '@sigx/server/plugin';
import { App } from './App';

export function createApp(_url?: string, _request?: Request, _platform?: unknown): SigxApp<unknown> {
    return defineApp(<App />).use(serverPlugin()) as SigxApp<unknown>;
}
