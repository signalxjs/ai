/**
 * Every agent the playground can open, and what it runs on.
 *
 * Server-only: the adapters, the provider SDKs, the keys, the tool
 * implementations and the policy live here and never ship. Nothing at module
 * scope spawns anything — an agent is built when a session asks for one.
 *
 * Layering: `catalog` <- this <- `registry.server` <- `agent.server`.
 */
import { defineTool, type LanguageModel } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import { anthropic } from '@sigx/ai-anthropic';
import { openai } from '@sigx/ai-openai';
import { agentTool, modelAgent, allowReadOnly, type Agent, type SessionOptions } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';
import type { CodingSessionOptions } from '@sigx/ai-agent/coding';
import { ExecutableNotFoundError } from '@sigx/ai-agent-node';
import { z } from 'zod';
import { AGENTS, INSTALL, type AgentChoice, type CatalogEntry, type HarnessChoice, type ModelChoice, type OpenRequest } from './catalog.js';

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

/** A tool result for a sentence: text as it is, anything else as JSON (never `[object Object]`). */
function describeOutput(output: unknown): string {
    return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * The scripted host model — no key needed: hand the reading to the `triage`
 * sub-agent, restart what it found (which stops and asks), then answer.
 */
function demoModel(): LanguageModel {
    return mockModel({
        respond: (request) => {
            const last = request.messages[request.messages.length - 1];
            if (last?.role === 'tool') {
                const result = last.content[0];
                if (result?.toolName === 'triage' || result?.toolName === 'list_incidents') {
                    // A cancelled (or failed) sub-agent comes back as a tool error: the turn goes on without it.
                    if (result.isError) return { text: `Triage did not finish — ${describeOutput(result.output)}. Nothing was restarted.`, delayMs: 30 };
                    return { toolCalls: [{ name: 'restart_service', input: { service: 'checkout' } }], delayMs: 30 };
                }
                if (result?.toolName === 'restart_service') {
                    return {
                        text: result.isError
                            ? `Left checkout alone — ${describeOutput(result.output)}. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model.`
                            : 'Restarted checkout. INC-41 should recover within a minute.',
                        delayMs: 30
                    };
                }
                return { text: 'Done.', delayMs: 30 };
            }
            const asked = last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
            if (/incident|restart|deploy|outage|check/i.test(asked)) {
                // Reasoning the harness EXPOSES, so the transcript shows the
                // other half of the story: a harness running with thinking
                // display `omitted` gives the view nothing but a live
                // indicator (#77/#78/#121).
                return {
                    reasoning: 'The operator wants the incidents looked at. Reading them is work for the `triage` sub-agent: it only reads, so the policy lets it start unasked. Anything that restarts a service has to stop and ask.',
                    toolCalls: [{ name: 'triage', input: { task: 'List the open incidents and say which one to act on first.' } }],
                    delayMs: 30
                };
            }
            return {
                text: 'Hello from the scripted mock model. Ask about the incidents to see a sub-agent triage them, and a destructive tool stop for your approval — or set ANTHROPIC_API_KEY / OPENAI_API_KEY for a real model.',
                delayMs: 30
            };
        }
    });
}

/**
 * The sub-agent's own script: read the incidents, then report. The pause
 * before its tool call is deliberate — long enough to watch its card run, and
 * to press its Cancel.
 */
function triageModel(): LanguageModel {
    // Its call ids may repeat the host's — both mocks number from `call_1`.
    // `agentTool` namespaces what it forwards, so the two spaces stay apart.
    return mockModel({
        respond: (request) => {
            const last = request.messages[request.messages.length - 1];
            if (last?.role === 'tool') {
                return { text: 'INC-41 first: checkout latency is over 2s on /pay, the only high-severity incident. INC-42, a stale search index, can wait.', delayMs: 30 };
            }
            return { toolCalls: [{ name: 'list_incidents', input: {} }], delayMs: 1500 };
        }
    });
}

const TriageInput = z.object({ task: z.string().describe('What the triage sub-agent should find out') });

/**
 * A SUB-AGENT as a tool. `agentTool` opens a session on a second
 * `modelAgent` for each call; because the host is `modelAgent` too, the
 * delegate is a sub-agent of the host turn — an `agent-start` bound to this
 * call, its own messages nested under it, `agent-update`s, exactly one
 * terminal status — and `cancelAgent` stops it while the turn goes on.
 *
 * It only reads, so it is annotated read-only and the host's `allowReadOnly`
 * starts it unasked; inside, the same policy judges its own tool calls.
 * Our engine only: a harness has its own sub-agents, reported the same way.
 */
function triage(model: LanguageModel) {
    const delegate = modelAgent({
        model,
        system: 'You triage incidents for an operations agent. Read, never change anything, and report in two sentences.',
        tools: [listIncidents],
        maxSteps: 4
    });
    return agentTool(delegate, {
        name: 'triage',
        title: 'Triage',
        description: 'A sub-agent that reads the open incidents and reports which one to act on first.',
        input: TriageInput,
        jsonSchema: z.toJSONSchema(TriageInput),
        annotations: { readOnly: true },
        prompt: ({ task }) => task,
        sessionOptions: { policy: allowReadOnly, interactive: true, requestTimeoutMs: 5 * 60_000 }
    });
}

/**
 * One env var, VALIDATED against the values we actually understand: an
 * unrecognised one warns and falls back, so a typo — or a variable the
 * ignored while the banner echoes it back.
 */
function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = process.env[name];
    if (!value) return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    console.warn(`[agent] ${name}=${value} is not one of ${allowed.join(' | ')} — using ${fallback}.`);
    return fallback;
}

/**
 * The adapter for a selection. Every import is dynamic so a missing SDK is
 * a printed reason, not a crash at module load. `SIGX_AI_AGENT_COMMAND`
 * points at a specific executable (a locally built CLI, a shim outside PATH).
 * Every harness is a coding agent — its session options carry a `cwd`.
 */
/** An env var that is set to nothing (`SIGX_AI_CWD=` in a `.env`) counts as unset. */
function env(name: string): string | undefined {
    return process.env[name] || undefined;
}

async function harness(choice: HarnessChoice): Promise<Agent<CodingSessionOptions>> {
    const command = env('SIGX_AI_AGENT_COMMAND');
    switch (choice) {
        case 'claude-code': {
            const { claudeCode } = await import('@sigx/ai-agent-claude-code');
            // The SDK bundles its own binary, so the override is an option on the adapter, not a PATH lookup.
            return claudeCode(command ? { pathToClaudeCodeExecutable: command } : {});
        }
        case 'codex': {
            const { codex } = await import('@sigx/ai-agent-codex');
            return codex(command ? { command } : {});
        }
        default: {
            const { acp, gemini, cursor, claudeCodeAcp, codexAcp } = await import('@sigx/ai-agent-acp');
            const presets = { 'acp:gemini': gemini, 'acp:cursor': cursor, 'acp:claude-code': claudeCodeAcp, 'acp:codex': codexAcp } as const;
            return acp({ ...presets[choice](), ...(command ? { command } : {}) });
        }
    }
}

/**
 * Why a harness could not start, in one line an operator can act on.
 *
 * An explicit choice never falls back. Picking `codex` in the form and
 * silently getting `sigx` would be a lie in a tool whose whole purpose is
 * comparing agents — the reason comes back to the form instead.
 */
export function unavailable(choice: HarnessChoice, error: unknown): string {
    if (error instanceof ExecutableNotFoundError) {
        const override = env('SIGX_AI_AGENT_COMMAND');
        // The resolver throws the same error for a name looked up on PATH and
        // for an explicit path that does not exist — say which one it was.
        if (override) return `SIGX_AI_AGENT_COMMAND="${override}" was not found (${error.message}).`;
        return `Needs the "${error.executable}" CLI on PATH — install it (${INSTALL[choice]}) or point SIGX_AI_AGENT_COMMAND at it.`;
    }
    return error instanceof Error ? error.message : String(error);
}

// ── Models ──────────────────────────────────────────────────────────────────

/**
 * The models our own engine offers, namespaced by provider so one id names one
 * model and the catalogue entry and the factory cannot disagree. A provider
 * with no key is left out rather than offered and then failing at open time.
 */
const PROVIDER_MODELS: Record<'anthropic' | 'openai', readonly string[]> = {
    anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    openai: ['gpt-5', 'gpt-5-mini']
};

function configured(provider: 'anthropic' | 'openai'): boolean {
    return Boolean(provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
}

/** Every model `sigx` can run, with the scripted mock last so there is always one. */
export function sigxModels(): ModelChoice[] {
    const out: ModelChoice[] = [];
    for (const provider of ['anthropic', 'openai'] as const) {
        if (!configured(provider)) continue;
        for (const id of PROVIDER_MODELS[provider]) out.push({ id: `${provider}:${id}`, label: `${provider} / ${id}` });
    }
    out.push({ id: 'mock:demo', label: 'scripted mock (no key)' });
    return out;
}

/**
 * A namespaced id back to a model, for the HOST. Anything unknown falls back
 * to the script, so a stale id cannot fail a turn.
 */
function languageModel(id: string | undefined): LanguageModel {
    const at = (id ?? '').indexOf(':');
    const provider = at === -1 ? '' : (id as string).slice(0, at);
    const rest = at === -1 ? '' : (id as string).slice(at + 1);
    if (provider === 'anthropic' && rest && configured('anthropic')) return anthropic().model(rest);
    if (provider === 'openai' && rest && configured('openai')) return openai().model(rest);
    return demoModel();
}

/**
 * The model the `triage` sub-agent runs on. A real provider plays both parts;
 * the scripted mock needs a script of its OWN — handed the host's, it would
 * answer a delegation by delegating again.
 */
function triageModelFor(id: string | undefined): LanguageModel {
    const host = languageModel(id);
    return host.provider === 'mock' ? triageModel() : host;
}

/**
 * The scripted agent: a key-less harness stand-in that advertises real
 * `config` options, so the config panel has something to drive on a machine
 * with no CLI installed and no key. Like Claude Code it announces them on its
 * first turn rather than at open — `mockAgent` emits `config` only from a
 * script step — which is exactly the case the panel has to handle honestly.
 */
function scriptedAgent(): Agent {
    const config = [
        {
            id: 'mode',
            label: 'Mode',
            values: [
                { id: 'ask', label: 'Ask every time' },
                { id: 'plan', label: 'Plan only', description: 'Read and propose; change nothing.' },
                { id: 'auto', label: 'Accept edits' }
            ],
            current: 'ask'
        },
        { id: 'model', label: 'Model', values: [{ id: 'mock-1' }, { id: 'mock-2' }], current: 'mock-1' }
    ];
    return mockAgent({
        id: 'mock',
        script: [
            [
                { config },
                { text: 'Reading the open incidents.', reasoning: 'Reading the incidents is free; restarting a service is not, so that one has to ask.' },
                { tool: { name: 'list_incidents', input: {}, annotations: { readOnly: true }, output: [{ id: 'INC-41', service: 'checkout', severity: 'high' }] } },
                { tool: { name: 'restart_service', input: { service: 'checkout' }, annotations: { destructive: true }, output: { restarted: true } } },
                { text: ' INC-41 is the one to act on.' }
            ]
        ]
    });
}

// ── Building one ────────────────────────────────────────────────────────────

/**
 * The options every session gets, whichever agent it is. `allowReadOnly`
 * answers the read-only calls and says `'ask'` for the rest; `interactive:
 * true` turns an `'ask'` into a `request` event the UI answers with
 * `respond()`. `requestTimeoutMs` is the safety net: an operator who closes
 * the tab must not leave a turn waiting for ever.
 */
const SESSION_OPTIONS = {
    policy: allowReadOnly,
    interactive: true,
    requestTimeoutMs: 5 * 60_000,
    tools: TOOLS
} as const;

/**
 * The agent for a choice. The registry keeps one per harness and reuses it
 * across that harness's sessions — one process hosts many conversations.
 */
export async function createAgent(choice: AgentChoice): Promise<Agent> {
    if (choice === 'mock') return scriptedAgent();
    if (choice === 'sigx') {
        const models = sigxModels().map((m) => languageModel(m.id));
        // `models` is what makes the model dropdown live: the session
        // advertises them and `configure({ model })` switches between them.
        return modelAgent({ model: models[0] ?? demoModel(), models, system: SYSTEM, maxSteps: 6 });
    }
    return harness(choice);
}

/** What a session on `choice` is opened with. */
export function sessionOptionsFor(choice: AgentChoice, request: OpenRequest): SessionOptions {
    if (choice === 'sigx') {
        // The tools go in ONCE, through the session: `modelAgent` adds a
        // session's tools to its own, so naming them on both would offer every
        // tool twice — and a real provider rejects duplicate tool names. The
        // `triage` sub-agent is our engine's alone; a harness has its own.
        return { ...SESSION_OPTIONS, ...(request.model ? { model: request.model } : {}), tools: [...TOOLS, triage(triageModelFor(request.model))] };
    }
    if (choice === 'mock') return SESSION_OPTIONS;
    // A harness works in a directory.
    const coding: CodingSessionOptions = {
        ...SESSION_OPTIONS,
        cwd: request.cwd || env('SIGX_AI_CWD') || process.cwd(),
        ...(request.model ? { model: request.model } : {})
    };
    return coding;
}

// ── The catalogue ───────────────────────────────────────────────────────────

const LABELS: Record<AgentChoice, string> = {
    sigx: 'sigx (our engine)',
    mock: 'mock (scripted)',
    'claude-code': 'Claude Code',
    codex: 'Codex',
    'acp:gemini': 'Gemini CLI (ACP)',
    'acp:cursor': 'Cursor CLI (ACP)',
    'acp:claude-code': 'Claude Code (ACP bridge)',
    'acp:codex': 'Codex (ACP bridge)'
};

/**
 * What the New-session form offers. Availability is LEARNED: an agent is
 * listed until an attempt to open it fails, and the reason is kept to show
 * next to it. Probing every CLI up front would copy each adapter's knowledge
 * of its own executable name into the example, and would be wrong the moment
 * one of them changes it — which has already happened once (#124).
 */
export function entries(failures: ReadonlyMap<AgentChoice, string>): CatalogEntry[] {
    return AGENTS.map((id) => {
        const harnessId = id !== 'sigx' && id !== 'mock' ? (id as HarnessChoice) : undefined;
        const failed = failures.get(id);
        return {
            id,
            label: LABELS[id],
            kind: (id === 'sigx' ? 'engine' : id === 'mock' ? 'mock' : 'harness') as CatalogEntry['kind'],
            // A harness reports its own models as a `config` option once it is
            // up; that list is the authoritative one, and it is the only one.
            models: id === 'sigx' ? sigxModels() : [],
            needsCwd: harnessId !== undefined,
            ...(harnessId ? { install: INSTALL[harnessId] } : {}),
            ...(failed ? { unavailable: failed } : {})
        };
    });
}

/**
 * What the form starts on. The env vars still choose — they just no longer
 * decide for the whole process.
 */
export function defaults(): { agent: AgentChoice; model?: string; cwd: string } {
    const agent = pick('SIGX_AI_AGENT', AGENTS, 'sigx');
    const provider = pick('SIGX_AI_PROVIDER', ['anthropic', 'openai', 'mock'] as const, configured('anthropic') ? 'anthropic' : configured('openai') ? 'openai' : 'mock');
    const model = provider === 'mock' ? 'mock:demo' : `${provider}:${env('SIGX_AI_MODEL') ?? (provider === 'anthropic' ? 'claude-opus-5' : 'gpt-5')}`;
    return { agent, ...(agent === 'sigx' ? { model } : {}), cwd: env('SIGX_AI_CWD') ?? process.cwd() };
}
