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
| [`@sigx/ai-agent`](./packages/ai-agent) | **Experimental.** The agent layer: one provider-neutral `Agent` contract for agent harnesses (Claude Code, Codex, ACP agents) and our own engine — events with `(epoch, seq)` stamps, capabilities, the policy engine, session helpers for adapters, plus `@sigx/ai-agent/wire` (`serveSession` / `connectSession`), `@sigx/ai-agent/app` (`useAgentSession`) and `@sigx/ai-agent/testing` (`mockAgent`) |
| [`@sigx/ai-agent-node`](./packages/ai-agent-node) | **Experimental.** The Node building blocks for agent adapters: a cross-platform process supervisor (process-group / `taskkill /T` kill, Web Streams stdio), executable resolution that understands Windows (`Path`, `PATHEXT`, npm `.cmd` shims run under `process.execPath`), a child environment allowlist, and a loopback MCP listener |
| [`@sigx/ai-agent-acp`](./packages/ai-agent-acp) | **Experimental.** Every Agent Client Protocol agent as an `Agent` — Gemini CLI, Cursor, Copilot CLI's own ACP server, the Claude Code and Codex ACP bridges — with vendors as data-only presets; permissions through the policy, client tools over MCP, opt-in fs/terminal client methods fenced to the working directory |
| [`@sigx/ai-agent-claude-code`](./packages/ai-agent-claude-code) | **Experimental.** Claude Code as an `@sigx/ai-agent` Agent on the official Claude Agent SDK — sessions with resume/fork, permissions through the policy, client tools over MCP, structured output |
| [`@sigx/ai-agent-codex-cli`](./packages/ai-agent-codex-cli) | **Experimental.** The Codex CLI as an `Agent` over the `codex app-server` JSON-RPC protocol — threads as sessions (resume, fork, list), approvals and questions through your policy, `defineTool` tools as Codex dynamic tools, `coding.*` events for commands and patches |
| [`@sigx/ai-agent-copilot-cli`](./packages/ai-agent-copilot-cli) | **Experimental.** GitHub Copilot CLI as an `Agent` on the official `@github/copilot-sdk` — sessions with resume and list, the runtime's permission asks through your policy, `defineTool` tools run in-process, a switchable model list, sub-agents observed |
| [`@sigx/ai-anthropic`](./packages/ai-anthropic) | Claude on the official `@anthropic-ai/sdk` — streaming, tool use, adaptive thinking, refusal handling |
| [`@sigx/ai-openai`](./packages/ai-openai) | OpenAI on the official `openai` SDK — Responses API streaming and function calling |
| [`@sigx/json-ui`](./packages/json-ui) | **Proof of concept** — UI from JSON: a streamable JSON UI spec, a catalog that validates it, safe expressions, reactive state, async actions, and a platform-neutral renderer (`UIView`) with a web component pack. No AI dependency; `@sigx/ai/ui` hands it to a model as a tool |

Examples:

- [`examples/chat`](./examples/chat) — the **`@sigx/ai` playground**: an SSR sigx app streaming a chat over `serverStream`, with the provider and model picked in the page per conversation (and validated server-side against the same table the picker renders from). Assistant text renders as markdown by `RichTextView` from `@sigx/richtext/dom`; a scripted mock runs when no key is set.
- [`examples/agent`](./examples/agent) — the **`@sigx/ai-agent` playground**: open a session against any agent (`sigx`, `mock`, Claude Code, Codex, GitHub Copilot CLI, any ACP preset), on any model, in any mode — from the page, not from `.env`. Several at once, side by side on the same prompt. Switch a running session into plan mode or onto another model from its Settings panel, which is one `<select>` per `ConfigOption` and knows no adapter's vocabulary. Tool cards, permission prompts, sub-agent cards, cancel and usage; a second tab joins every live session and replays it. Runs with no key and no installed harness.

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
