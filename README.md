<div align="center">

# SignalX AI

**AI for [SignalX](https://sigx.dev/) — streaming models, tools and agents on signals.**

[![npm](https://img.shields.io/npm/v/@sigx/ai.svg?label=@sigx/ai&color=blue)](https://www.npmjs.com/package/@sigx/ai)
[![license](https://img.shields.io/npm/l/@sigx/ai.svg)](./LICENSE)
[![ci](https://github.com/signalxjs/ai/actions/workflows/ci.yml/badge.svg)](https://github.com/signalxjs/ai/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/@sigx/ai.svg)](https://www.typescriptlang.org/)

</div>

> 🚧 Early release. The API surface is small and stabilising — feedback is very welcome.

## 📚 Documentation

Full guides, API reference and live examples → **<https://sigx.dev/ai/>**

## Packages

| Package | What |
|---|---|
| [`@sigx/ai`](./packages/ai) | Provider-neutral core: the `LanguageModel` seam, `UIMessage` and the `UIChunk` stream protocol, `defineTool`, `streamText` / `generateText` / `streamObject`, plus `@sigx/ai/app` (`useChat`, `useCompletion`, `useObject`), `@sigx/ai/server` (`chatStream` for `serverStream` handlers) and `@sigx/ai/testing` (`mockModel`) |
| [`@sigx/ai-anthropic`](./packages/ai-anthropic) | Claude on the official `@anthropic-ai/sdk` — streaming, tool use, adaptive thinking, refusal handling |
| [`@sigx/ai-openai`](./packages/ai-openai) | OpenAI on the official `openai` SDK — Responses API streaming and function calling |

Examples: [`examples/chat`](./examples/chat) — an SSR sigx app streaming a chat over `serverStream`, assistant text rendered as markdown via `@sigx/markdown/dom`, provider switched by env, a scripted mock when no key is set.

## Install

```bash
npm install @sigx/ai @sigx/ai-anthropic @anthropic-ai/sdk
# or
npm install @sigx/ai @sigx/ai-openai openai
```

## Quick start

```ts
// src/ai.server.ts — server only, never ships to the browser
import { serverStream } from '@sigx/server';
import { defineTool } from '@sigx/ai';
import { chatStream } from '@sigx/ai/server';
import { anthropic } from '@sigx/ai-anthropic';
import { z } from 'zod';

const model = anthropic().model('claude-opus-5');

const weather = defineTool({
    name: 'get_weather',
    description: 'Current weather for a city',
    input: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, tempC: 21 })
});

export const chat = serverStream({
    input: ChatInput,
    handler: async function* (rq, input) {
        yield* chatStream({ model, tools: [weather], messages: input.messages, signal: rq.abortSignal });
    }
});
```

```tsx
// Chat.tsx
import { component } from 'sigx';
import { useChat } from '@sigx/ai/app';
import { chat } from './ai.server';

export const Chat = component(() => {
    const thread = useChat({ stream: (input) => chat(input) });
    return () => (
        <>
            {thread.messages.map((m) => <Message message={m} />)}
            <Composer onSubmit={(text) => thread.send(text)} busy={thread.status === 'streaming'} />
        </>
    );
});
```

Every assistant message is made of signals: a streaming text delta updates one text node, never the transcript.

## Why this exists

- **Fine-grained streaming state** — a token touches one signal, not a component tree.
- **SSR-first AI pages** — `useCompletion` streams a model answer inside the first HTML response and hydrates it without a second model call (built on core's `useStream`).
- **One seam, many providers** — the core knows nothing about vendors; a provider package only translates.
- **Testable without a model** — `mockModel` scripts deterministic chunks for tests, docs and CI.

## Part of SignalX

- [`core`](https://sigx.dev/core/) — `reactivity`, `runtime-core`, `runtime-dom`, `server-renderer`, `server`, `vite`, `sigx`
- [`actors`](https://sigx.dev/actors/) — virtual actors (durable agents are built on these)
- [`router`](https://sigx.dev/router/) · [`store`](https://sigx.dev/store/) · [`use`](https://sigx.dev/use/) · [`lynx`](https://sigx.dev/lynx/) · [`terminal`](https://sigx.dev/terminal/)
- [Docs site](https://sigx.dev/) — main SignalX documentation

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). PRs welcome.

## License

MIT © Andreas Ekdahl
