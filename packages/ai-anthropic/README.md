# @sigx/ai-anthropic

Claude for [`@sigx/ai`](https://www.npmjs.com/package/@sigx/ai) — a
`LanguageModel` on the official `@anthropic-ai/sdk`. Streams
`client.messages.stream`, maps text, thinking and tool-use blocks and
`stop_reason` (including `refusal`) onto the core's events. Adaptive
thinking is the default; `providerOptions` passes `thinking`, `output_config`,
`fallbacks` and `betas` straight through.

```ts
import { anthropic } from '@sigx/ai-anthropic';

const model = anthropic().model('claude-opus-5');
// anthropic({ apiKey }) or anthropic({ client: new Anthropic(...) })
```

## Install

```bash
npm install @sigx/ai @sigx/ai-anthropic @anthropic-ai/sdk
```

Peers on `@anthropic-ai/sdk` — the app owns the SDK copy and its version.

## Documentation

Guides and the provider option reference: **<https://sigx.dev/ai/>**

## License

MIT © Andreas Ekdahl
