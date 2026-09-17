/**
 * The chat endpoint — a `serverStream` whose body is ONE `chatStream` call.
 *
 * This module is server-only: the provider SDKs, the API key and the tool
 * implementations live here and never ship. The client build swaps it for a
 * typed stub; `useChat` calls `chat(input)` and reads the NDJSON stream.
 *
 * The provider and model come with each REQUEST — the picker in the page
 * sends them — and are checked against the catalogue's allowlist before a
 * model is built. The env vars only choose what the picker starts on, so
 * `pnpm dev` still works with no key at all.
 */
import { serverFn, serverStream } from '@sigx/server';
import { defineTool, type LanguageModel, type StandardSchemaV1 } from '@sigx/ai';
import { chatStream, ChatInput } from '@sigx/ai/server';
import { CATALOG, PROVIDERS, defaultFor, isOffered, type ChatCatalog, type ProviderChoice, type Selection } from './catalog.js';
import { mockModel } from '@sigx/ai/testing';
import { anthropic } from '@sigx/ai-anthropic';
import { openai } from '@sigx/ai-openai';
import { uiTool } from '@sigx/ai/ui';
import type { UISpec } from '@sigx/json-ui';
import { z } from 'zod';

const SYSTEM =
    'You are a concise assistant in a SignalX demo app. Use the tools when they help; keep answers short. ' +
    'When the user asks for something visual or interactive — a form, a list, a counter, a calculator, a small app — build it with render_ui instead of describing it.';

// ── Tools ───────────────────────────────────────────────────────────────────

const WeatherInput = z.object({ city: z.string().describe('City name, e.g. "Oslo"') });

const weather = defineTool({
    name: 'get_weather',
    description: 'Current weather for a city (demo data).',
    input: WeatherInput,
    jsonSchema: z.toJSONSchema(WeatherInput),
    execute: async ({ city }) => {
        await new Promise((r) => setTimeout(r, 300)); // a "network" hop, so the pending state is visible
        const seed = [...city.toLowerCase()].reduce((n, c) => n + c.charCodeAt(0), 0);
        return { city, tempC: (seed % 35) - 5, sky: ['clear', 'cloudy', 'rain', 'snow'][seed % 4] };
    }
});

const TimeInput = z.object({ timeZone: z.string().describe('IANA time zone, e.g. "Europe/Oslo"') });

const time = defineTool({
    name: 'get_time',
    description: 'The current local time in a time zone.',
    input: TimeInput,
    jsonSchema: z.toJSONSchema(TimeInput),
    execute: ({ timeZone }) => ({ timeZone, now: new Date().toLocaleString('en-GB', { timeZone }) })
});

const EmailInput = z.object({ to: z.string().describe('Recipient address'), body: z.string().describe('Message body') });

/**
 * A tool that must not run on the model's say-so alone. `chatStream` defers
 * the decision to the client: the turn stops with the call `awaiting`, the
 * UI shows Approve / Deny, and the transcript comes back with the answer.
 */
const sendEmail = defineTool({
    name: 'send_email',
    description: 'Send an email on the user\'s behalf (demo: nothing is sent).',
    input: EmailInput,
    jsonSchema: z.toJSONSchema(EmailInput),
    needsApproval: true,
    annotations: { openWorld: true },
    execute: ({ to }) => ({ sent: true, to })
});

/**
 * The UI tool: the model builds an interface from the base catalog and the
 * browser renders it while the arguments stream. Its description is the
 * catalog itself, so the model knows the components without extra prompt.
 */
const renderUi = uiTool();

/**
 * What the mock "writes" when asked for a UI: a small todo app, streamed as
 * tool-input deltas so the interface visibly appears piece by piece.
 */
const DEMO_UI: UISpec = {
    version: 1,
    state: { draft: '', todos: [{ id: 'a', title: 'Try the scripted mock', done: true }, { id: 'b', title: 'Add a todo below', done: false }] },
    computed: { remaining: { $: 'count(todos, !it.done)' } },
    actions: {
        add: [
            { do: 'state.push', path: 'todos', value: { $: '{ id: uid(), title: trim(draft), done: false }' }, if: { $: 'trim(draft) != ""' } },
            { do: 'state.set', path: 'draft', value: '' }
        ]
    },
    root: {
        type: 'card',
        props: { title: 'Todos' },
        children: [
            { type: 'text', props: { text: '{{remaining}} of {{todos.length}} left', variant: 'caption' } },
            {
                type: 'stack',
                props: { direction: 'row', gap: 8 },
                children: [
                    { type: 'input', bind: 'draft', props: { placeholder: 'What needs doing?' }, on: { submit: [{ do: 'call', action: 'add' }] } },
                    { type: 'button', props: { label: 'Add', disabled: { $: 'trim(draft) == ""' } }, on: { press: [{ do: 'call', action: 'add' }] } }
                ]
            },
            {
                type: 'list',
                for: { items: { $: 'todos' }, as: 'todo', key: { $: 'todo.id' } },
                props: { gap: 4 },
                children: [
                    {
                        type: 'stack',
                        props: { direction: 'row', gap: 8, align: 'center' },
                        children: [
                            { type: 'button', props: { label: { $: 'todo.done ? "✓" : "○"' }, variant: 'ghost', size: 'sm' }, on: { press: [{ do: 'state.toggle', path: 'todo.done' }] } },
                            { type: 'text', props: { text: '{{todo.title}}', style: { $: 'todo.done ? { textDecoration: "line-through", opacity: 0.6 } : {}' } } },
                            { type: 'button', props: { label: 'Remove', variant: 'danger', size: 'sm' }, on: { press: [{ do: 'state.remove', path: 'todos', where: { $: 'it.id == todo.id' } }] } }
                        ]
                    }
                ]
            },
            { type: 'text', if: { $: 'todos.length == 0' }, props: { text: 'All done. Nice.', variant: 'caption' } },
            { type: 'divider' },
            { type: 'button', props: { label: 'Tell the assistant how many are left', variant: 'secondary' }, on: { press: [{ do: 'emit', name: 'send', payload: { text: 'I have {{remaining}} todos left. Any advice?' } }] } }
        ]
    }
};

/** The spec as the model would stream it: JSON in small pieces. */
function deltas(spec: UISpec, size: number): string[] {
    const text = JSON.stringify({ spec });
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
}

// ── Model ───────────────────────────────────────────────────────────────────

/**
 * One env var, VALIDATED against the values we actually understand: an
 * unrecognised one warns and falls back, so a typo — or a variable the
 * surrounding tooling happens to set — is visible instead of silently
 * ignored while the banner echoes it back.
 */
function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = process.env[name];
    if (!value) return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    console.warn(`[chat] ${name}=${value} is not one of ${allowed.join(' | ')} — using ${fallback}.`);
    return fallback;
}

/** A provider is offered only when the key its SDK reads is actually set. */
function configured(provider: ProviderChoice): boolean {
    return provider.keyEnv === undefined || Boolean(process.env[provider.keyEnv]);
}

/**
 * The clients are built ONCE and lazily: constructing one without its key
 * throws, so a provider nobody picked must not be constructed at all.
 */
const clients: { anthropic?: ReturnType<typeof anthropic>; openai?: ReturnType<typeof openai> } = {};

/**
 * A model per REQUEST. The real providers are one shared client (stateless
 * per call); the mock records every request it sees, so sharing one across
 * users would grow without bound and answer from process history — a fresh
 * one per turn keeps it deterministic.
 */
function modelFor(selection: Selection): LanguageModel {
    switch (selection.provider) {
        case 'anthropic':
            clients.anthropic ??= anthropic();
            return clients.anthropic.model(selection.model);
        case 'openai':
            clients.openai ??= openai();
            return clients.openai.model(selection.model);
        default:
            return mockModel({
                respond: (req) => {
                    // Decided from the conversation, never from call history.
                    const last = req.messages[req.messages.length - 1];
                    if (last?.role === 'tool') {
                        const result = last.content[0];
                        if (result?.toolName === 'send_email') {
                            return { text: result.isError ? `The mock says: not sent — ${String(result.output)}` : 'The mock says: email sent (well, pretended).', delayMs: 40 };
                        }
                        if (result?.toolName === 'render_ui') {
                            return { text: 'There is your todo list — add one, tick one off, or press the last button to talk to me from inside it.', delayMs: 40 };
                        }
                        return { text: 'The mock says: Oslo looks fine today. (Pick a real model above, once a key is set.)', delayMs: 40 };
                    }
                    const asks = last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
                    if (/weather/i.test(asks)) return { toolCalls: [{ name: 'get_weather', input: { city: 'Oslo' }, inputDeltas: ['{"city":', ' "Os', 'lo"}'] }], delayMs: 40 };
                    if (/email/i.test(asks)) return { toolCalls: [{ name: 'send_email', input: { to: 'someone@example.com', body: asks } }], delayMs: 40 };
                    if (/\b(ui|todo|app|form|list|counter)\b/i.test(asks)) return { toolCalls: [{ name: 'render_ui', input: { spec: DEMO_UI }, inputDeltas: deltas(DEMO_UI, 24) }], delayMs: 25 };
                    if (/left|advice/i.test(asks)) return { text: 'Advice from the mock: do the top one first. (That message came from a button inside the generated UI.)', delayMs: 40 };
                    return { text: 'Hello from the scripted mock model. Ask about the weather to see a tool call, say "email" to see one that asks for approval, say "build me a todo app" to watch a UI stream in, or pick a real model above once a key is set.', delayMs: 40 };
                }
            });
    }
}

/**
 * What the picker starts on. The env vars still choose — they just no longer
 * decide for the process, and they cannot choose a provider that has no key:
 * the default has to be one of the providers the catalogue offers.
 */
function defaultSelection(usable: readonly ProviderChoice[]): Selection {
    const { selection, warning } = defaultFor(usable, pick('SIGX_AI_PROVIDER', PROVIDERS, process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'mock'), process.env.SIGX_AI_MODEL);
    if (warning) console.warn(`[chat] ${warning}`);
    return selection;
}

/** The providers the browser may pick from, and what to start on. Never a key — only names. */
export const catalog = serverFn({
    input: z.object({}),
    allowAnonymous: true,
    handler: (): ChatCatalog => {
        const providers = CATALOG.filter(configured);
        return { providers, selected: defaultSelection(providers) };
    }
});

/**
 * The endpoint's input: `messages` through `ChatInput` UNCHANGED — it already
 * does the careful work — plus the selection, checked against the catalogue.
 *
 * The selection is attacker-controlled like the transcript is. Validating it
 * against the same table the picker renders from is what stops a request
 * naming an arbitrary model, and keeps the two from drifting apart.
 */
interface ChatRequest extends ChatInput {
    readonly selection: Selection;
}

const ChatRequest: StandardSchemaV1<ChatRequest, ChatRequest> = {
    '~standard': {
        version: 1,
        vendor: 'chat-example',
        validate(value: unknown) {
            const messages = ChatInput['~standard'].validate(value);
            if ('issues' in messages && messages.issues) return { issues: [...messages.issues] };
            const selection = (value as { selection?: unknown }).selection as Selection | undefined;
            if (!selection || typeof selection !== 'object') return { issues: [{ message: 'a provider and model are required', path: ['selection'] }] };
            // Against what this server can actually SERVE, not the whole
            // catalogue: a provider whose key is missing is a bad request, not
            // a failure when the client is built. The picker hiding it is not
            // a check — nothing stops a client posting one anyway.
            if (!isOffered(CATALOG.filter(configured), selection)) {
                return { issues: [{ message: `"${String(selection.provider)}" / "${String(selection.model)}" is not a model this server offers`, path: ['selection'] }] };
            }
            return { value: { messages: (messages as { value: ChatInput }).value.messages, selection } };
        }
    }
};

// ── The endpoint ────────────────────────────────────────────────────────────

export const chat = serverStream({
    // The wire transcript AND the model choice are attacker-controlled:
    // `ChatRequest` checks the shape of one and the allowlist for the other
    // before a model is built.
    input: ChatRequest,
    // Deliberate: the demo has no sign-in. See vite.config.ts.
    allowAnonymous: true,
    // `@sigx/server` 0.15: `handler(rq, input)`. Core main's 1.0 form is
    // `handler({ input, rq })` — one destructuring to flip when it ships.
    handler: async function* (rq, input) {
        yield* chatStream({
            model: modelFor(input.selection),
            system: SYSTEM,
            tools: [weather, time, sendEmail, renderUi],
            messages: input.messages,
            maxSteps: 4,
            // OpenAI streams reasoning text only when asked for a summary; without
            // it a GPT-5 turn is silent for the whole think (a minute for a UI).
            // Anthropic's adaptive thinking is summarized by default. `effort` is
            // the knob to trade wait for quality ('low' | 'medium' | 'high').
            ...(input.selection.provider === 'openai' ? { providerOptions: { reasoning: { summary: 'auto' } } } : {}),
            // A closed tab aborts the model call and any running tool.
            signal: rq.abortSignal
        });
    }
});
