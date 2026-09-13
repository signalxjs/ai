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

## Steering a running turn

`streamText({ steer })` injects user input into a turn that is already
running. The engine polls `steer` between model rounds — after a round's
tool results, and when a round answered without tool calls — and, when it
returns anything, appends the messages and asks the model again:

```ts
const queued: ModelUserMessage[] = [];
const stream = streamText({ model, messages, tools, steer: () => queued.splice(0) });
// later, while the turn runs:
queued.push({ role: 'user', content: 'Also check the staging cluster.' });
```

Every round counts against `maxSteps` (a steer that lands on the last round
ends the turn with `finish { reason: 'length' }`). No chunk is yielded for
the injected messages — the caller owns that part of the transcript. This is
the seam an agent session's `prompt()`-while-running uses.

## A typed result from a tool-using turn

`streamObject` / `generateObject` produce JSON without tools. For "use tools,
then answer with an object", give `streamText` (or `generateText`) an
`output`:

```ts
const { output, finishReason } = await generateText({
    model,
    messages,
    tools: [weather],
    output: { schema: Verdict } // Standard Schema; `jsonSchema` when the library cannot derive one
});
if (finishReason === 'stop') output.ok; // typed by the schema; present exactly when the turn completed
```

Every model round asks for the JSON format (tools still run); the final
answer is validated and arrives on `finish.output` (`useChat`'s `onFinish`
receives it too). A final answer that does not parse or validate ends the
turn with an `error` chunk; a turn cut short by the token limit, a refusal, or
one waiting on the client carries no `output` — check `finishReason`.

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
