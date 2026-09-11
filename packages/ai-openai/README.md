# @sigx/ai-openai

OpenAI for [`@sigx/ai`](https://www.npmjs.com/package/@sigx/ai) — a
`LanguageModel` on the official `openai` SDK over the Responses API.
Streams text and reasoning summaries, maps function calls onto the core's
tool events, reports usage. `providerOptions` passes `reasoning`, `store`
and friends straight through.

```ts
import { openai } from '@sigx/ai-openai';

const model = openai().model('gpt-5');
// openai({ apiKey }) or openai({ client: new OpenAI(...) })
```

## Install

```bash
npm install @sigx/ai @sigx/ai-openai openai
```

Peers on `openai` — the app owns the SDK copy and its version.

## Documentation

Guides and the provider option reference: **<https://sigx.dev/ai/>**

## License

MIT © Andreas Ekdahl
