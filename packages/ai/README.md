# @sigx/ai

AI for [SignalX](https://sigx.dev/) — the provider-neutral core: a
`LanguageModel` seam one provider package per vendor implements, a
transcript and stream protocol the UI consumes, `defineTool`, and the
engine (`streamText` / `generateText` / `streamObject` / `generateObject`)
that runs the tool loop once for every vendor. Zero dependencies, no `node:`
imports — Node, workerd and the edge alike.

Four entries:

| Entry | What |
|---|---|
| `@sigx/ai` | the seam, the protocol, `defineTool`, the engine |
| `@sigx/ai/app` | `useChat`, `useCompletion`, `useObject` — composables on `@sigx/runtime-core` |
| `@sigx/ai/server` | `chatStream` for `serverStream` handlers, `ChatInput` wire schema |
| `@sigx/ai/testing` | `mockModel` — a scripted model for tests, docs and CI |

## Install

```bash
npm install @sigx/ai
# plus a provider:
npm install @sigx/ai-anthropic @anthropic-ai/sdk
```

Peers on `@sigx/reactivity` and `@sigx/runtime-core` at the same minor as
your app's `sigx`.

## Documentation

Guides, API reference and live examples: **<https://sigx.dev/ai/>**

Providers: [`@sigx/ai-anthropic`](https://www.npmjs.com/package/@sigx/ai-anthropic),
[`@sigx/ai-openai`](https://www.npmjs.com/package/@sigx/ai-openai).

## License

MIT © Andreas Ekdahl
