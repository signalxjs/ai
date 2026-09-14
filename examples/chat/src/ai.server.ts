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
import { CATALOG, PROVIDERS, isKnown, type ChatCatalog, type ProviderChoice, type Selection } from './catalog.js';
import { mockModel } from '@sigx/ai/testing';
import { anthropic } from '@sigx/ai-anthropic';
import { openai } from '@sigx/ai-openai';
import { z } from 'zod';

const SYSTEM = 'You are a concise assistant in a SignalX demo app. Use the tools when they help; keep answers short.';

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
                        return { text: 'The mock says: Oslo looks fine today. (Pick a real model above, once a key is set.)', delayMs: 40 };
                    }
                    const asks = last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
                    if (/weather/i.test(asks)) return { toolCalls: [{ name: 'get_weather', input: { city: 'Oslo' }, inputDeltas: ['{"city":', ' "Os', 'lo"}'] }], delayMs: 40 };
                    if (/email/i.test(asks)) return { toolCalls: [{ name: 'send_email', input: { to: 'someone@example.com', body: asks } }], delayMs: 40 };
                    return { text: 'Hello from the scripted mock model. Ask about the weather to see a tool call, say "email" to see one that asks for approval, or pick a real model above once a key is set.', delayMs: 40 };
                }
            });
    }
}

/** What the picker starts on: the env vars still choose, they just no longer decide for the process. */
function defaultSelection(): Selection {
    const provider = pick('SIGX_AI_PROVIDER', PROVIDERS, process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'mock');
    const entry = CATALOG.find((p) => p.id === provider)!;
    const wanted = process.env.SIGX_AI_MODEL;
    // An env model that is not in the catalogue would be refused by the very
    // allowlist the picker renders from, so fall back rather than offer it.
    const model = wanted && entry.models.some((m) => m.id === wanted) ? wanted : entry.models[0]!.id;
    if (wanted && model !== wanted) console.warn(`[chat] SIGX_AI_MODEL=${wanted} is not one of ${entry.label}'s models — using ${model}.`);
    return { provider, model };
}

/** The providers the browser may pick from, and what to start on. Never a key — only names. */
export const catalog = serverFn({
    input: z.object({}),
    allowAnonymous: true,
    handler: (): ChatCatalog => ({ providers: CATALOG.filter(configured), selected: defaultSelection() })
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
            if (!isKnown(selection)) return { issues: [{ message: `"${String(selection.provider)}" / "${String(selection.model)}" is not a model this server offers`, path: ['selection'] }] };
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
            tools: [weather, time, sendEmail],
            messages: input.messages,
            maxSteps: 4,
            // A closed tab aborts the model call and any running tool.
            signal: rq.abortSignal
        });
    }
});
