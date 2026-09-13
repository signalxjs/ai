/**
 * The browser entry. `agentCommand` / `agentEvents` here are the
 * build-swapped stubs: a POST to `/_sigx/fn/…` and an NDJSON stream
 * `connectSession` reads frame by frame. `hydrate` adopts the server's
 * markup instead of rendering over it.
 */
import { defineApp } from 'sigx';
import { hydrate } from '@sigx/server-renderer/client';
import { serverPlugin } from '@sigx/server/plugin';
import { App } from './App';

defineApp(<App />)
    .use(serverPlugin())
    .mount(document.getElementById('app')!, hydrate);
