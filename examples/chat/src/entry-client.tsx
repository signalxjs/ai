/**
 * The browser entry. `chat()` here is the build-swapped stub: a POST to
 * `/_sigx/fn/…` whose NDJSON body `useChat` reads chunk by chunk. `hydrate`
 * adopts the server's markup instead of rendering over it.
 */
import { defineApp } from 'sigx';
import { hydrate } from '@sigx/server-renderer/client';
import { serverPlugin } from '@sigx/server/plugin';
import { App } from './App';

defineApp(<App />)
    .use(serverPlugin())
    .mount(document.getElementById('app')!, hydrate);
