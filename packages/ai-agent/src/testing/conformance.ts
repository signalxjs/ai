/**
 * `agentConformance` — the suite every adapter must pass.
 *
 * Each scenario tells the factory what the agent must do (call the `guarded`
 * tool once, ask a question, …) and the suite drives the session the way a
 * client would: answers requests, cancels, resumes, then checks the
 * invariants. A case is skipped — with a reason — when the agent's
 * capabilities do not cover what it needs; never by `agent.id`. No test
 * runner import: consumers wire the cases into theirs, e.g.
 *
 * ```ts
 * for (const c of agentConformance(make, { capabilities: myAgent.capabilities })) {
 *     it.skipIf(!!c.skip)(c.name, c.run);
 * }
 * ```
 */

import { defineTool, type AnyTool, type JsonSchema, type StandardSchemaV1, type ToolContext } from '@sigx/ai';
import type { AgentCapabilities, AgentEvent, ConfigOption, StopReason } from '../protocol/index.js';
import { AgentError, SessionBusyError } from '../protocol/index.js';
import { allowAll, type Policy } from '../policy/index.js';
import type { Agent, AgentSession, SessionOptions, TurnResult } from '../session/index.js';
import { createReducer } from '../state/index.js';
import { assert, assertEqual } from './assert.js';
import { checkEventInvariants, checkReplayEquality, checkResultMatchesTurnEnd } from './invariants.js';

export interface ConformanceScenario {
    readonly name: string;
    /** What the agent under test must do when prompted — the factory scripts it. */
    readonly description: string;
    readonly prompt: string;
    /** Tools passed as `SessionOptions.tools`; a native-tool agent may implement them itself. */
    readonly tools: readonly AnyTool[];
    readonly interactive: boolean;
    readonly policy?: Policy;
    /** Structured output requested for the prompt, if any. */
    readonly outputSchema?: JsonSchema;
    /** Session options the scenario itself needs (a short `requestTimeoutMs`, say); merged after the caller's. */
    readonly sessionOptions?: Partial<SessionOptions>;
    /** Capabilities the scenario needs; a case is skipped when they are missing. */
    readonly needs: Partial<AgentCapabilities>;
}

export interface ConformanceCase {
    readonly name: string;
    /** Why the case does not apply to this agent (missing capability). */
    readonly skip?: string;
    run(): Promise<void>;
}

export interface ConformanceOptions {
    /** The agent's capabilities, to compute skips up front; otherwise checked at run time. */
    readonly capabilities?: AgentCapabilities;
    /**
     * Skip a scenario for a reason capabilities cannot express (an engine that
     * never asks the client a question, say). Return the reason, or `undefined`.
     */
    readonly skip?: (scenario: ConformanceScenario) => string | undefined;
    /** Extra session options for every scenario (an adapter's `cwd`, an executable path, …). */
    readonly sessionOptions?: Partial<SessionOptions> & Record<string, unknown>;
    /** Milliseconds a scenario may take. Default 10 000. */
    readonly timeoutMs?: number;
}

/** Accepts any input — the scenarios exercise the loop, not argument validation. */
const anySchema: StandardSchemaV1<unknown, unknown> = { '~standard': { version: 1, vendor: 'sigx-ai-agent', validate: (value) => ({ value }) } };
const objectSchema: JsonSchema = { type: 'object', additionalProperties: true };
const tool = (name: string, description: string, execute: (input: unknown, ctx: ToolContext) => unknown): AnyTool =>
    defineTool({ name, description, input: anySchema, jsonSchema: objectSchema, execute });

export const CONFORMANCE_TOOLS = {
    /** Returns `{ ok: true }`. */
    guarded: tool('guarded', 'A tool that needs permission; returns { ok: true }.', () => ({ ok: true })),
    /** Always throws. */
    failing: tool('failing', 'A tool that always fails.', () => {
        throw new Error('the tool failed on purpose');
    }),
    /** Waits until the turn is cancelled. */
    slow: tool('slow', 'A tool that never finishes on its own.', (_input, ctx) => new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
};

const OUTPUT_SCHEMA: JsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true };

export const CONFORMANCE_SCENARIOS: readonly ConformanceScenario[] = [
    { name: 'text', description: 'Reply with some text and end the turn.', prompt: 'Say hello.', tools: [], interactive: false, needs: {} },
    {
        name: 'tool-permission',
        description: 'Call the `guarded` tool once (it needs permission; the client allows it), then end the turn.',
        prompt: 'Use the guarded tool.',
        tools: [CONFORMANCE_TOOLS.guarded],
        interactive: true,
        needs: { permissions: 'every-call' }
    },
    {
        name: 'headless-deny',
        description: 'Call the `guarded` tool once in a non-interactive session with no policy; the call is denied and the turn still ends normally.',
        prompt: 'Use the guarded tool.',
        tools: [CONFORMANCE_TOOLS.guarded],
        interactive: false,
        needs: { permissions: 'every-call' }
    },
    {
        name: 'tool-error',
        description: 'Call the `failing` tool once (it throws); report the failure and end the turn normally.',
        prompt: 'Use the failing tool.',
        tools: [CONFORMANCE_TOOLS.failing],
        interactive: false,
        policy: allowAll,
        needs: {}
    },
    {
        name: 'slow-tool',
        description: 'Call the `slow` tool (it never returns); the client cancels the turn while it runs.',
        prompt: 'Use the slow tool.',
        tools: [CONFORMANCE_TOOLS.slow],
        interactive: false,
        policy: allowAll,
        needs: { cancel: true }
    },
    { name: 'model-error', description: 'Fail the turn with an `error` event (e.g. a provider error).', prompt: 'Trigger an error.', tools: [], interactive: false, needs: {} },
    { name: 'resume', description: 'Two turns: reply with text; after resume, reply with text again.', prompt: 'Say hello.', tools: [], interactive: false, needs: { resume: 'local' } },
    { name: 'input-request', description: 'Ask the client a question (`request { kind: input }`), then end the turn.', prompt: 'Ask me something.', tools: [], interactive: true, needs: {} },
    {
        name: 'structured-output',
        description: 'Return `{ ok: true }` as the structured output.',
        prompt: 'Return ok.',
        tools: [],
        interactive: false,
        outputSchema: OUTPUT_SCHEMA,
        needs: { structuredOutput: true }
    },
    {
        name: 'support-agent',
        description: 'A non-coding flow: ask the client a question, emit an `agent.handoff` ext event, return `{ ok: true }` as structured output.',
        prompt: 'Help me with my plan.',
        tools: [],
        interactive: true,
        outputSchema: OUTPUT_SCHEMA,
        needs: { structuredOutput: true }
    },
    { name: 'busy-session', description: 'Reply with text (the suite prompts twice at once).', prompt: 'Say hello.', tools: [], interactive: false, needs: {} },
    {
        name: 'session-grant',
        description: 'Call the `guarded` tool twice in a row (the client allows the first call for the session; the second must not ask), then end the turn.',
        prompt: 'Use the guarded tool twice.',
        tools: [CONFORMANCE_TOOLS.guarded],
        interactive: true,
        needs: { permissions: 'every-call' }
    },
    {
        name: 'request-timeout',
        description: 'Call the `guarded` tool once (the client never answers; the request times out and the call is denied), then end the turn normally.',
        prompt: 'Use the guarded tool.',
        tools: [CONFORMANCE_TOOLS.guarded],
        interactive: true,
        sessionOptions: { requestTimeoutMs: 50 },
        needs: { permissions: 'every-call' }
    },
    {
        name: 'configure',
        description: 'Announce at least one `config` option with two or more values (during the turn or when the session opens), reply with text; the suite then switches that option through `configure()` and expects a `config` event reflecting it.',
        prompt: 'Say hello.',
        tools: [],
        interactive: false,
        needs: { config: true }
    },
    { name: 'fork', description: 'Two turns of text (the suite forks the session after the first and prompts both).', prompt: 'Say hello.', tools: [], interactive: false, needs: { fork: true, resume: 'local' } },
    { name: 'list-sessions', description: 'Reply with text; the suite then expects `listSessions()` to include the session.', prompt: 'Say hello.', tools: [], interactive: false, needs: { listSessions: true } },
    { name: 'late-join', description: 'Reply with text; the suite then replays the session from `{ epoch: 0, seq: 0 }` and expects the same events, gapless from seq 1.', prompt: 'Say hello.', tools: [], interactive: false, needs: {} },
    {
        name: 'portable-resume',
        description: 'Two turns of text; after the first the ref is resumed on a NEW agent instance (nothing but the ref carries over).',
        prompt: 'Say hello.',
        tools: [],
        interactive: false,
        needs: { resume: 'portable' }
    },
    { name: 'prompt-after-close', description: 'Reply with text (the suite closes the session, then prompts again and closes again).', prompt: 'Say hello.', tools: [], interactive: false, needs: {} },
    { name: 'respond-unknown', description: 'Reply with text (the suite first answers a request that does not exist).', prompt: 'Say hello.', tools: [], interactive: false, needs: {} },
    { name: 'usage', description: 'Reply with text and report token usage (a `usage` event with input/output or total tokens).', prompt: 'Say hello.', tools: [], interactive: false, needs: {} }
];

/** `resume: 'local'` in `needs` means "any resume" (`portable` satisfies it too); every other value must match exactly. */
function missingCapability(needs: Partial<AgentCapabilities>, caps: AgentCapabilities): string | undefined {
    for (const [key, value] of Object.entries(needs) as [keyof AgentCapabilities, unknown][]) {
        const actual = caps[key];
        if (key === 'resume' && value === 'local') {
            if (!actual) return `needs the resume capability (agent has resume: false)`;
            continue;
        }
        if (actual !== value) return `needs ${key}: ${JSON.stringify(value)} (agent has ${JSON.stringify(actual)})`;
    }
    return undefined;
}

export function agentConformance(make: (scenario: ConformanceScenario) => Agent | Promise<Agent>, options: ConformanceOptions = {}): ConformanceCase[] {
    return CONFORMANCE_SCENARIOS.map((scenario) => {
        const skip = (options.capabilities ? missingCapability(scenario.needs, options.capabilities) : undefined) ?? options.skip?.(scenario);
        return {
            name: `conformance: ${scenario.name}`,
            ...(skip ? { skip } : {}),
            run: async () => {
                const agent = await make(scenario);
                const reason = missingCapability(scenario.needs, agent.capabilities);
                if (reason) return; // skipped at run time when capabilities were not known up front
                await withTimeout(runScenario(scenario, agent, options, make), options.timeoutMs ?? 10_000, scenario.name);
            }
        };
    });
}

async function runScenario(scenario: ConformanceScenario, agent: Agent, options: ConformanceOptions, make: (scenario: ConformanceScenario) => Agent | Promise<Agent>): Promise<void> {
    const sessionOptions: SessionOptions = {
        ...options.sessionOptions,
        ...scenario.sessionOptions,
        tools: scenario.tools,
        interactive: scenario.interactive,
        ...(scenario.policy ? { policy: scenario.policy } : {})
    };
    const session = await agent.session(sessionOptions);
    const all: AgentEvent[] = [];
    const subscription = session.subscribe();
    const pump = (async () => {
        for await (const e of subscription) all.push(e);
    })();
    const allow = (scope: 'once' | 'session') => async (e: AgentEvent) => {
        if (e.type === 'request' && e.kind === 'permission') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope });
    };
    try {
        switch (scenario.name) {
            case 'text': {
                const r = await runTurn(session, scenario);
                assert(textOf(r.events).length > 0, 'expected some text');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'tool-permission': {
                const r = await runTurn(session, scenario, allow('once'));
                const req = r.events.find((e) => e.type === 'request');
                assert(req, 'expected a permission request');
                const res = r.events.find((e) => e.type === 'request-resolved');
                assert(res && res.type === 'request-resolved' && res.by === 'client' && res.outcome === 'allow', 'expected the request to be resolved by the client with allow');
                assert(r.events.some((e) => e.type === 'tool-update' && e.status === 'completed'), 'expected the tool to complete');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'headless-deny': {
                const r = await runTurn(session, scenario);
                const res = r.events.filter((e) => e.type === 'request-resolved');
                assert(res.length >= 1, 'expected a request resolution');
                assert(res.every((e) => e.type === 'request-resolved' && e.by === 'policy' && e.outcome === 'deny'), 'a headless ask must resolve to deny by policy');
                assert(r.events.some((e) => e.type === 'tool-update' && e.status === 'denied'), 'expected the tool to be denied');
                assert(!r.events.some((e) => e.type === 'request'), 'a headless session must not emit request events');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'tool-error': {
                const r = await runTurn(session, scenario);
                assert(r.events.some((e) => e.type === 'tool-update' && e.status === 'failed'), 'expected a failed tool-update');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'slow-tool': {
                let cancelled = false;
                const r = await runTurn(session, scenario, async (e) => {
                    if (!cancelled && e.type === 'tool-update' && (e.status === 'in_progress' || e.status === 'pending')) {
                        cancelled = true;
                        await session.cancel();
                    }
                });
                assert(cancelled, 'the slow tool never started');
                assertStop(r.result, 'cancelled');
                break;
            }
            case 'model-error': {
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'error');
                assert(r.result.error !== undefined, 'turn-end with stopReason error must carry error');
                assert(r.events.some((e) => e.type === 'error'), 'expected an error event');
                break;
            }
            case 'resume': {
                const first = await runTurn(session, scenario);
                assertStop(first.result, 'end_turn');
                const ref = session.ref;
                assert(typeof ref.id === 'string' && ref.agent === agent.id, 'ref must name the agent and the session');
                assert(jsonSafe(ref), 'ref must be plain JSON');
                await session.close();
                await pump; // the closed log ends the subscription
                const resumed = await agent.session({ ...sessionOptions, resume: ref });
                try {
                    const second = await runTurn(resumed, scenario);
                    assertStop(second.result, 'end_turn');
                    assert(second.events[0]!.epoch > first.events[0]!.epoch || resumed.id !== session.id, 'a resumed session must start a new epoch');
                } finally {
                    await resumed.close();
                }
                return;
            }
            case 'input-request': {
                const r = await runTurn(session, scenario, async (e) => {
                    if (e.type === 'request' && e.kind === 'input') await session.respond(e.requestId, { type: 'input', answers: { answer: 'yes' } });
                });
                const res = r.events.find((e) => e.type === 'request-resolved');
                assert(res && res.type === 'request-resolved' && res.outcome === 'input' && res.by === 'client', 'expected the input request to be answered by the client');
                assertEqual(res.answers, { answer: 'yes' }, 'answers must travel on request-resolved');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'structured-output': {
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'end_turn');
                assert(typeof r.result.output === 'object' && r.result.output !== null && (r.result.output as { ok?: unknown }).ok === true, 'expected output { ok: true }');
                break;
            }
            case 'support-agent': {
                const r = await runTurn(session, scenario, async (e) => {
                    if (e.type === 'request' && e.kind === 'input') await session.respond(e.requestId, { type: 'input', answers: { plan: 'pro' } });
                });
                assert(r.events.some((e) => e.type === 'request-resolved' && e.outcome === 'input'), 'expected an answered input request');
                assert(r.events.some((e) => e.type === 'ext' && e.ns === 'agent' && e.name === 'handoff'), 'expected an agent.handoff ext event');
                assert((r.result.output as { ok?: unknown } | undefined)?.ok === true, 'expected output { ok: true }');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'busy-session': {
                const first = session.prompt(scenario.prompt);
                const second = session.prompt(scenario.prompt);
                if (agent.capabilities.steer) {
                    await second.result;
                } else {
                    let rejected: unknown;
                    await second.result.catch((e: unknown) => (rejected = e));
                    assert(rejected instanceof SessionBusyError, 'a prompt during a turn must reject with SessionBusyError');
                }
                const result = await first.result;
                assertStop(result, 'end_turn');
                break;
            }
            case 'session-grant': {
                const r = await runTurn(session, scenario, allow('session'));
                const requests = r.events.filter((e) => e.type === 'request');
                assert(requests.length === 1, `a session grant must settle the second call without asking (saw ${requests.length} requests)`);
                const calls = r.events.filter((e) => e.type === 'tool-call');
                assert(calls.length >= 2, `expected the guarded tool to be called twice (saw ${calls.length} calls)`);
                const resolved = r.events.filter((e): e is Extract<AgentEvent, { type: 'request-resolved' }> => e.type === 'request-resolved');
                assert(resolved.length >= 2, 'every call must be resolved, granted ones included');
                assert(resolved[0]!.by === 'client' && resolved[0]!.outcome === 'allow' && resolved[0]!.scope === 'session', 'the first call is allowed by the client for the session');
                assert(resolved[1]!.by === 'policy' && resolved[1]!.outcome === 'allow' && resolved[1]!.ruleId === 'grant', 'the second call is allowed by the session grant (by: policy, ruleId: grant)');
                assert(r.events.filter((e) => e.type === 'tool-update' && e.status === 'completed').length >= 2, 'both calls must complete');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'request-timeout': {
                const r = await runTurn(session, scenario);
                assert(r.events.some((e) => e.type === 'request' && e.kind === 'permission'), 'expected a permission request');
                const res = r.events.find((e) => e.type === 'request-resolved');
                assert(res && res.type === 'request-resolved' && res.by === 'timeout' && res.outcome === 'deny', 'an unanswered request must resolve to deny by timeout');
                assert(r.events.some((e) => e.type === 'tool-update' && e.status === 'denied'), 'expected the tool to be denied');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'configure': {
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'end_turn');
                assert(session.configure, 'an agent with the config capability must expose configure()');
                const option = switchable(await configOptions(session, all));
                assert(option, 'expected a config option with two or more values and a current one among them');
                const next = option.values.find((v) => v.id !== option.current)!;
                const before = all.length;
                await session.configure({ [option.id]: next.id });
                const updated = await waitFor(() => all.slice(before).find((e) => e.type === 'config' && e.options.some((o) => o.id === option.id && o.current === next.id)), 2000);
                assert(updated, `expected a config event with "${option.id}" switched to "${next.id}"`);
                break;
            }
            case 'fork': {
                const first = await runTurn(session, scenario);
                assertStop(first.result, 'end_turn');
                const ref = session.ref;
                const forked = await agent.session({ ...sessionOptions, resume: ref, fork: true });
                try {
                    assert(forked.id !== session.id, 'a fork is a new session with its own id');
                    const second = await runTurn(forked, scenario);
                    assertStop(second.result, 'end_turn');
                    // The original goes on unaffected.
                    const third = await runTurn(session, scenario);
                    assertStop(third.result, 'end_turn');
                } finally {
                    await forked.close();
                }
                break;
            }
            case 'list-sessions': {
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'end_turn');
                assert(agent.listSessions, 'an agent with the listSessions capability must expose listSessions()');
                const summaries = await agent.listSessions();
                const ref = session.ref;
                const own = summaries.find((s) => s.ref.id === ref.id);
                assert(own, `listSessions() must include the open session "${ref.id}" (saw ${JSON.stringify(summaries.map((s) => s.ref.id))})`);
                assert(own.ref.agent === agent.id, 'a listed ref names the agent');
                assert(jsonSafe(own), 'a session summary must be plain JSON');
                break;
            }
            case 'late-join': {
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'end_turn');
                const replayed: AgentEvent[] = [];
                for await (const e of session.subscribe({ epoch: 0, seq: 0 })) {
                    replayed.push(e);
                    if (e.type === 'turn-end' && e.turnId === r.result.turnId) break;
                }
                assert(replayed[0]?.seq === 1, `a replay from (0, 0) starts at seq 1 (saw ${replayed[0]?.epoch}:${replayed[0]?.seq})`);
                checkEventInvariants(replayed, { fromStart: true });
                checkReplayEquality(replayed, createReducer());
                // Everything the live subscriber saw up to the turn's end is in the replay, unchanged.
                const seen = new Map(replayed.map((e) => [`${e.epoch}:${e.seq}`, e.type] as const));
                const end = all.findIndex((e) => e.type === 'turn-end' && e.turnId === r.result.turnId);
                assert(end >= 0, 'the live subscription must have seen the turn end');
                for (const e of all.slice(0, end + 1)) assert(seen.get(`${e.epoch}:${e.seq}`) === e.type, `event ${e.epoch}:${e.seq} (${e.type}) is missing from the replay or differs`);
                break;
            }
            case 'portable-resume': {
                const first = await runTurn(session, scenario);
                assertStop(first.result, 'end_turn');
                const ref = JSON.parse(JSON.stringify(session.ref)) as typeof session.ref;
                await session.close();
                await pump;
                const other = await make(scenario);
                const resumed = await other.session({ ...sessionOptions, resume: ref });
                try {
                    assert(resumed.id === session.id, 'a portable ref resumes the same session id on another instance');
                    const second = await runTurn(resumed, scenario);
                    assertStop(second.result, 'end_turn');
                    assert(second.events[0]!.epoch > first.events[0]!.epoch, 'a resumed session must start a new epoch');
                } finally {
                    await resumed.close();
                }
                return;
            }
            case 'prompt-after-close': {
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'end_turn');
                await session.close();
                let rejected: unknown;
                await session.prompt(scenario.prompt).result.catch((e: unknown) => (rejected = e));
                assert(rejected instanceof AgentError && rejected.code === 'protocol_error', `a prompt after close() must reject with AgentError(protocol_error), got ${String(rejected)}`);
                await session.close(); // idempotent
                await pump;
                return;
            }
            case 'respond-unknown': {
                await session.respond('no-such-request', { type: 'permission', outcome: 'allow', scope: 'once' });
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'end_turn');
                assert(!all.some((e) => e.type === 'request-resolved'), 'answering an unknown request resolves nothing');
                break;
            }
            case 'usage': {
                const r = await runTurn(session, scenario);
                assertStop(r.result, 'end_turn');
                const usages = all.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
                assert(usages.length >= 1, 'expected a usage event');
                const counted = (u: Extract<AgentEvent, { type: 'usage' }>) => ['inputTokens', 'outputTokens', 'totalTokens'].some((k) => typeof u.usage[k] === 'number');
                assert(usages.some(counted), 'a usage event must carry inputTokens, outputTokens or totalTokens as numbers');
                if (usages.at(-1)!.scope === 'turn') assert(r.result.usage !== undefined, 'a turn-scoped usage event must be reflected on turn-end.usage');
                break;
            }
        }
    } finally {
        await session.close().catch(() => {});
        await pump.catch(() => {});
        // The invariants hold over everything the session emitted.
        checkEventInvariants(all);
        checkReplayEquality(all, createReducer());
    }
}

interface TurnRun {
    readonly events: AgentEvent[];
    readonly result: TurnResult;
}

async function runTurn(session: AgentSession, scenario: ConformanceScenario, onEvent?: (e: AgentEvent) => Promise<void> | void): Promise<TurnRun> {
    const turn = session.prompt(scenario.prompt, scenario.outputSchema ? { output: { schema: scenario.outputSchema } } : undefined);
    const events: AgentEvent[] = [];
    for await (const e of turn) {
        events.push(e);
        if (onEvent) await onEvent(e);
    }
    const result = await turn.result;
    assert(events[0]?.type === 'turn-start', 'a turn must begin with turn-start');
    assert(events.at(-1)?.type === 'turn-end', 'a turn must end with turn-end');
    assert(events.every((e) => e.turnId === turn.id), 'every event of a turn carries its turnId');
    checkResultMatchesTurnEnd(events, result);
    return { events, result };
}

/** The options of the last `config` event seen live — or, when the session announced them before the client attached, from a replay. */
async function configOptions(session: AgentSession, all: readonly AgentEvent[]): Promise<readonly ConfigOption[]> {
    const live = all.findLast((e) => e.type === 'config');
    if (live && live.type === 'config') return live.options;
    const head = all.at(-1);
    let options: readonly ConfigOption[] = [];
    try {
        for await (const e of session.subscribe({ epoch: 0, seq: 0 })) {
            if (e.type === 'config') options = e.options;
            if (!head || (e.epoch === head.epoch && e.seq >= head.seq) || e.epoch > head.epoch) break;
        }
    } catch {
        // A session that cannot replay from the start has no announced config to find.
    }
    return options;
}

function switchable(options: readonly ConfigOption[]): ConfigOption | undefined {
    return options.find((o) => o.values.length >= 2 && o.values.some((v) => v.id === o.current));
}

async function waitFor<T>(probe: () => T | undefined, ms: number): Promise<T | undefined> {
    const deadline = Date.now() + ms;
    for (;;) {
        const found = probe();
        if (found !== undefined) return found;
        if (Date.now() >= deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function assertStop(result: TurnResult, expected: StopReason): void {
    assert(result.stopReason === expected, `expected stopReason "${expected}", got "${result.stopReason}"${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}`);
}

function textOf(events: readonly AgentEvent[]): string {
    let out = '';
    for (const e of events) if (e.type === 'part-delta') out += e.delta;
    return out;
}

function jsonSafe(value: unknown): boolean {
    try {
        return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value);
    } catch {
        return false;
    }
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`conformance scenario "${name}" did not finish within ${ms} ms`)), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e);
            }
        );
    });
}
