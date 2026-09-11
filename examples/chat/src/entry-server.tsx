/**
 * The SSR entry: `createApp(url)` returns a FRESH app per request.
 *
 * `serverPlugin()` is load-bearing beyond configuration: importing
 * `@sigx/server` stamps the request scope the renderer opens around each
 * render, so an in-process server call during SSR sees a real request.
 */
import { defineApp, type App as SigxApp } from 'sigx';
import { serverPlugin } from '@sigx/server/plugin';
import { App } from './App';

export function createApp(_url?: string, _request?: Request, _platform?: unknown): SigxApp<unknown> {
    return defineApp(<App />).use(serverPlugin()) as SigxApp<unknown>;
}
