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

## Asking before a tool runs

```ts
const sendEmail = defineTool({
    name: 'send_email',
    description: 'Send an email',
    input: EmailInput,
    needsApproval: true, // or ({ to }) => !to.endsWith('@example.com')
    annotations: { openWorld: true },
    execute: ({ to, body }) => mailer.send(to, body)
});
```

`streamText` yields `tool-approval-request` and asks `onToolApproval` —
`'allow'`, `'deny'` / `{ deny: reason }`, or `'defer'`. Without a handler the
call is denied, never silently run. `chatStream` defers by default: the turn
ends with the call `awaiting`, `useChat` reports `status: 'awaiting'` and
`approvals`, and `approve(id)` / `deny(id, reason?)` send the transcript back
so the same assistant message resumes where it stopped.

The resumed transcript comes from the client, so in that flow the **client is
the approver**: whoever holds the transcript can mark a call `approved`, and
`chatStream`'s default handler honours it. Use it for tools the user is
entitled to run on their own say-so. A client's approval never runs a tool
by itself: a resumed `approved` call goes through `onToolApproval` again with
`ctx.approvedByClient` set, so a server-side handler (a policy, a role
check) can veto it — and bare `streamText` with no handler denies it.

## Sending an image or a file

A user message can carry `image` and `file` parts next to its text — plain
JSON, so they travel through `serverStream` and `ChatInput` unchanged:

```ts
import { encodeBase64, generateId } from '@sigx/ai';

await chat.send({
    id: generateId(),
    role: 'user',
    parts: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', mediaType: 'image/png', data: encodeBase64(bytes) }, // or { url }
        { type: 'file', mediaType: 'application/pdf', url: 'https://…/report.pdf', filename: 'report.pdf' }
    ]
});
```

Exactly one of `data` (standard base64) or `url` per part. `toModelMessages`
passes the parts through; each provider translates them (Anthropic: `image` /
`document` blocks — JPEG, PNG, GIF, WebP images, PDF and plain-text documents;
OpenAI: `input_image` / `input_file`) and refuses a media type it cannot take
at request time, which surfaces as one `error` chunk.

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
