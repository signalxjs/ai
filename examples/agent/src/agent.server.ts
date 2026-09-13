/**
 * The agent endpoint — ONE session, served to every tab.
 *
 * This module is server-only: the agent, the provider SDKs, the API key, the
 * tool implementations and the policy live here and never ship. The client
 * build swaps it for typed stubs, which is all `connectSession` needs: a
 * `serverFn` that carries commands in, and a `serverStream` that carries
 * event frames out.
 *
 * The agent is picked by env — `AI_AGENT=sigx|claude-code`, and within
 * `sigx` the model is `AI_PROVIDER=anthropic|openai|mock` — so `pnpm dev`
 * runs with no key and no installed executable.
 *
 * **Deliberately one process-wide session**: that is what makes the second
 * tab a LATE JOINER instead of a new conversation. A real app opens a
 * session per user (or per thread), keyed off `rq.principal`, and persists
 * `session.ref`.
 */
import { serverFn, serverStream } from '@sigx/server';
import { defineTool, type LanguageModel } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { anthropic } from '@sigx/ai-anthropic';
import { openai } from '@sigx/ai-openai';
import { modelAgent, allowReadOnly, memoryEventLog, type Agent, type AgentSession } from '@sigx/ai-agent';
import { serveSession, isWireCommand, WIRE_PROTOCOL_VERSION, type Cursor, type WireCommand, type WireFrame, type WireReply } from '@sigx/ai-agent/wire';
import { z } from 'zod';

const SYSTEM =
    'You are an operations agent in a SignalX demo. Use the tools when they help. ' +
    'Reading is free; anything that changes the world needs the operator to approve it.';

// ── Tools ───────────────────────────────────────────────────────────────────

const ListInput = z.object({ service: z.string().optional().describe('Only incidents for this service') });

/**
 * `readOnly: true` is not decoration: the session's policy is `allowReadOnly`,
 * which reads exactly this annotation and lets the call through without
 * asking. Everything else reaches the operator as a `request` event.
 */
const listIncidents = defineTool({
    name: 'list_incidents',
    description: 'Open incidents (demo data).',
    input: ListInput,
    jsonSchema: z.toJSONSchema(ListInput),
    annotations: { readOnly: true },
    execute: async ({ service }) => {
        await new Promise((r) => setTimeout(r, 200)); // a "network" hop, so `in_progress` is visible
        const all = [
            { id: 'INC-41', service: 'checkout', severity: 'high', summary: 'Latency over 2s on /pay' },
            { id: 'INC-42', service: 'search', severity: 'low', summary: 'Stale index in eu-north-1' }
        ];
        return service ? all.filter((i) => i.service === service) : all;
    }
});

const RestartInput = z.object({ service: z.string().describe('Service to restart, e.g. "checkout"') });

/** No `readOnly`: `allowReadOnly` has no opinion, so the turn stops and asks. */
const restartService = defineTool({
    name: 'restart_service',
    description: 'Restart a service (demo: nothing is restarted).',
    input: RestartInput,
    jsonSchema: z.toJSONSchema(RestartInput),
    annotations: { destructive: true },
    execute: async ({ service }) => ({ service, restarted: true, at: new Date().toISOString() })
});

const TOOLS = [listIncidents, restartService];

// ── The agent ───────────────────────────────────────────────────────────────

/** The scripted model: a two-step tool flow, then an answer — no key needed. */
function demoModel(): LanguageModel {
    return mockModel({
        respond: (request) => {
            const last = request.messages[request.messages.length - 1];
            if (last?.role === 'tool') {
                const result = last.content[0];
                if (result?.toolName === 'list_incidents') {
                    return { toolCalls: [{ name: 'restart_service', input: { service: 'checkout' } }], delayMs: 30 };
                }
                if (result?.toolName === 'restart_service') {
                    return {
                        text: result.isError
                            ? `Left checkout alone — ${String(result.output)}. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model.`
                            : 'Restarted checkout. INC-41 should recover within a minute.',
                        delayMs: 30
                    };
                }
                return { text: 'Done.', delayMs: 30 };
            }
            const asked = last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
            if (/incident|restart|deploy|outage|check/i.test(asked)) {
                return { toolCalls: [{ name: 'list_incidents', input: {} }], delayMs: 30 };
            }
            return {
                text: 'Hello from the scripted mock model. Ask about the incidents to see a read-only tool run unasked and a destructive one stop for your approval — or set ANTHROPIC_API_KEY / OPENAI_API_KEY for a real model.',
                delayMs: 30
            };
        }
    });
}

function modelFor(): LanguageModel {
    const wanted = process.env.AI_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : 'mock');
    switch (wanted) {
        case 'anthropic':
            return anthropic().model(process.env.AI_MODEL ?? 'claude-opus-5');
        case 'openai':
            return openai().model(process.env.AI_MODEL ?? 'gpt-5');
        default:
            return demoModel();
    }
}

/**
 * The options every agent gets, whichever one it is. `allowReadOnly` answers
 * the read-only calls and says `'ask'` for the rest; `interactive: true`
 * turns an `'ask'` into a `request` event the UI answers with `respond()`.
 * `requestTimeoutMs` is the safety net: an operator who closes the tab must
 * not leave a turn waiting for ever.
 */
const SESSION_OPTIONS = {
    policy: allowReadOnly,
    interactive: true,
    requestTimeoutMs: 5 * 60_000,
    tools: TOOLS
} as const;

/**
 * `AI_AGENT=claude-code` drives the real harness through the adapter, on the
 * operator's own Claude Code login. Optional on purpose: the import is
 * dynamic and any failure (SDK missing, no executable, not signed in) falls
 * back to our own engine with the reason printed, so the example always runs.
 * Swapping harnesses is the point of the contract — nothing below this
 * function changes.
 */
async function openSession(): Promise<{ agent: Agent; session: AgentSession }> {
    if ((process.env.AI_AGENT ?? 'sigx') === 'claude-code') {
        try {
            const { claudeCode } = await import('@sigx/ai-agent-claude-code');
            const agent = claudeCode();
            // Claude Code works in a directory; our own engine does not care.
            const session = await agent.session({ ...SESSION_OPTIONS, cwd: process.cwd() });
            return { agent, session };
        } catch (e) {
            console.warn(`[agent] AI_AGENT=claude-code is unavailable (${e instanceof Error ? e.message : String(e)}); falling back to the sigx engine.`);
        }
    }
    const agent = modelAgent({ model: modelFor(), system: SYSTEM, tools: TOOLS, maxSteps: 6 });
    return { agent, session: await agent.session(SESSION_OPTIONS) };
}

const { agent, session } = await openSession();

/**
 * `serveSession` is the whole server side of the wire: idempotent commands,
 * replay from any `(epoch, seq)`, a `hello` frame that carries the agent's
 * capabilities. The `memoryEventLog` lets a tab that has been away longer
 * than the session's in-memory buffer still replay instead of getting a
 * `gap` (a real app uses a durable `EventLogStore`).
 */
const served = serveSession(session, {
    agentId: agent.id,
    capabilities: agent.capabilities,
    eventLog: memoryEventLog(),
    // One frame per run of text deltas instead of one per token: the same
    // transcript, a fraction of the messages.
    coalesce: { maxDelayMs: 40 }
});

console.log(`[agent] agent: ${agent.id}  session: ${session.id}`);

// ── The endpoints ───────────────────────────────────────────────────────────

/** The wire envelope is validated by the library (`isWireCommand`); this only proves it is an object. */
const CommandInput = z.object({ command: z.looseObject({}) });

const CursorInput = z.object({ epoch: z.number().int().nonnegative(), seq: z.number().int().nonnegative() });
const EventsInput = z.object({ from: CursorInput.optional() });

/**
 * Commands in. `handleCommand` is idempotent by `commandId`, so a retried
 * POST never prompts twice or runs a turn twice.
 */
export const agentCommand = serverFn({
    input: CommandInput,
    // Deliberate: the demo has no sign-in. See vite.config.ts.
    allowAnonymous: true,
    handler: async (_rq, input): Promise<WireReply> => {
        const command = input.command as unknown;
        if (!isWireCommand(command)) {
            return { v: WIRE_PROTOCOL_VERSION, kind: 'error', commandId: '', code: 'invalid', message: 'not a wire command' };
        }
        // A real app passes `rq.principal` as the second argument and gives
        // `serveSession` an `authorize` — that is where "who may cancel whose
        // turn" is decided.
        return served.handleCommand(command as WireCommand);
    }
});

/**
 * Frames out. The stream is the session: `from` is the client's cursor, so a
 * reconnect resumes exactly where it stopped and a fresh tab asking for
 * `(0, 0)` replays the whole conversation before it goes live.
 */
export const agentEvents = serverStream({
    input: EventsInput,
    allowAnonymous: true,
    handler: async function* (rq, input): AsyncGenerator<WireFrame> {
        const from: Cursor | undefined = input.from;
        // A closed tab ends the subscription; the session keeps running.
        yield* served.events(from, { signal: rq.abortSignal });
    }
});
