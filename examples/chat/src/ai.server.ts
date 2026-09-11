/**
 * The chat endpoint — a `serverStream` whose body is ONE `chatStream` call.
 *
 * This module is server-only: the provider SDKs, the API key and the tool
 * implementations live here and never ship. The client build swaps it for a
 * typed stub; `useChat` calls `chat(input)` and reads the NDJSON stream.
 *
 * The provider is picked by env: `AI_PROVIDER=anthropic|openai|mock`, or
 * whichever key is set, or the scripted mock — so `pnpm dev` works with no
 * key at all.
 */
import { serverStream } from '@sigx/server';
import { defineTool } from '@sigx/ai';
import { chatStream, ChatInput } from '@sigx/ai/server';
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

// ── Model ───────────────────────────────────────────────────────────────────

function pickModel() {
    const wanted = process.env.AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'mock');
    switch (wanted) {
        case 'anthropic':
            return anthropic().model(process.env.AI_MODEL ?? 'claude-opus-5');
        case 'openai':
            return openai().model(process.env.AI_MODEL ?? 'gpt-5');
        default:
            return mockModel({
                respond: (req, round) => {
                    const last = req.messages[req.messages.length - 1];
                    const asksWeather = last?.role === 'user' && typeof last.content === 'string' && /weather/i.test(last.content);
                    if (asksWeather && round % 2 === 0) return { toolCalls: [{ name: 'get_weather', input: { city: 'Oslo' } }], delayMs: 40 };
                    if (last?.role === 'tool') return { text: 'The mock says: Oslo looks fine today. (Set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model.)', delayMs: 40 };
                    return { text: 'Hello from the scripted mock model. Ask about the weather to see a tool call, or set ANTHROPIC_API_KEY / OPENAI_API_KEY for a real model.', delayMs: 40 };
                }
            });
    }
}

const model = pickModel();
console.log(`[chat] model: ${model.provider}/${model.modelId}`);

// ── The endpoint ────────────────────────────────────────────────────────────

export const chat = serverStream({
    // The wire transcript is attacker-controlled: `ChatInput` checks its shape
    // (roles, part types, sizes, a message cap) before the model sees it.
    input: ChatInput,
    // Deliberate: the demo has no sign-in. See vite.config.ts.
    allowAnonymous: true,
    // `@sigx/server` 0.15: `handler(rq, input)`. Core main's 1.0 form is
    // `handler({ input, rq })` — one destructuring to flip when it ships.
    handler: async function* (rq, input) {
        yield* chatStream({
            model,
            system: SYSTEM,
            tools: [weather, time],
            messages: input.messages,
            maxSteps: 4,
            // A closed tab aborts the model call and any running tool.
            signal: rq.abortSignal
        });
    }
});
