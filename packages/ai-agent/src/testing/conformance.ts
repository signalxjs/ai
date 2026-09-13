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
import type { AgentCapabilities, AgentEvent, StopReason } from '../protocol/index.js';
import { SessionBusyError } from '../protocol/index.js';
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
    { name: 'busy-session', description: 'Reply with text (the suite prompts twice at once).', prompt: 'Say hello.', tools: [], interactive: false, needs: {} }
];

/** `resume: 'local'` in `needs` means "any resume"; other values must match exactly. */
function missingCapability(needs: Partial<AgentCapabilities>, caps: AgentCapabilities): string | undefined {
    for (const [key, value] of Object.entries(needs) as [keyof AgentCapabilities, unknown][]) {
        const actual = caps[key];
        if (key === 'resume') {
            if (!actual) return `needs the resume capability (agent has resume: false)`;
            continue;
        }
        if (actual !== value) return `needs ${key}: ${JSON.stringify(value)} (agent has ${JSON.stringify(actual)})`;
    }
    return undefined;
}

export function agentConformance(make: (scenario: ConformanceScenario) => Agent | Promise<Agent>, options: ConformanceOptions = {}): ConformanceCase[] {
    return CONFORMANCE_SCENARIOS.map((scenario) => {
        const skip = options.capabilities ? missingCapability(scenario.needs, options.capabilities) : undefined;
        return {
            name: `conformance: ${scenario.name}`,
            ...(skip ? { skip } : {}),
            run: async () => {
                const agent = await make(scenario);
                const reason = missingCapability(scenario.needs, agent.capabilities);
                if (reason) return; // skipped at run time when capabilities were not known up front
                await withTimeout(runScenario(scenario, agent, options), options.timeoutMs ?? 10_000, scenario.name);
            }
        };
    });
}

async function runScenario(scenario: ConformanceScenario, agent: Agent, options: ConformanceOptions): Promise<void> {
    const sessionOptions: SessionOptions = {
        ...options.sessionOptions,
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
    try {
        switch (scenario.name) {
            case 'text': {
                const r = await runTurn(session, scenario);
                assert(textOf(r.events).length > 0, 'expected some text');
                assertStop(r.result, 'end_turn');
                break;
            }
            case 'tool-permission': {
                const r = await runTurn(session, scenario, async (e) => {
                    if (e.type === 'request' && e.kind === 'permission') await session.respond(e.requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
                });
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
