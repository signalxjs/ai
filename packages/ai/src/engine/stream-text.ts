/**
 * The engine — `streamText`, `generateText`, `streamObject`, `generateObject`.
 *
 * One model round is `model.stream(request)`. A TURN is one or more rounds:
 * when a round ends with tool calls, the engine runs every tool (in
 * parallel — one result message per round, the shape every provider trains
 * on), appends the assistant round and the results to the conversation, and
 * asks the model again, up to `maxSteps`. Everything the UI needs arrives
 * as `UIChunk`s, in order, on one async iterable.
 *
 * A tool with `needsApproval` is gated: the engine yields
 * `tool-approval-request` and asks `onToolApproval` before running it. A
 * handler that answers `'defer'` hands the decision to the client — the
 * turn ends with `finish { reason: 'tool' }`, the call stays undecided in
 * the transcript, and the next `streamText` over that transcript RESUMES at
 * the tool phase (no model round) with the client's `approved` / `denied`
 * states applied. That is how a stateless `serverStream` asks a human.
 *
 * Abort is cooperative and total: `signal` reaches the provider (it aborts
 * the HTTP stream) and every tool (`ctx.signal`), and a consumer that
 * `break`s out of the iterable closes the provider stream through the
 * generator's `finally`.
 */

import { DENIED_MESSAGE, addUsage, toModelMessages, type LanguageModel, type ModelEvent, type ModelMessage, type ModelRequest } from '../model/index.js';
import { generateId, type FinishReason, type UIChunk, type UIMessage, type UIToolPart, type Usage } from '../protocol/index.js';
import { findTool, type AnyTool } from '../tool/index.js';
import { abortable, abortError, isAbort } from './abort.js';
import { toWireValue } from './wire-value.js';

/** The call `onToolApproval` decides on. */
export interface ToolApprovalCall {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
}

/**
 * `'allow'` runs the call; `'deny'` (or `{ deny: reason }`) returns an error
 * result the model sees; `'defer'` leaves the call undecided for the client
 * and ends the turn with `finish { reason: 'tool' }`.
 */
export type ToolApprovalDecision = 'allow' | 'deny' | 'defer' | { readonly deny: string };

export interface StreamTextOptions {
    readonly model: LanguageModel;
    readonly system?: string;
    /** A UI transcript or already-converted model messages. */
    readonly messages: readonly UIMessage[] | readonly ModelMessage[];
    readonly tools?: readonly AnyTool[];
    /** Model rounds per turn (1 = no tool loop). Default 5. */
    readonly maxSteps?: number;
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly signal?: AbortSignal;
    readonly providerOptions?: Readonly<Record<string, unknown>>;
    /** The id the `start` chunk announces; generated when omitted (a resumed turn re-announces its message). */
    readonly messageId?: string;
    /** Observe each model round as it finishes (usage accounting, logging). */
    readonly onStep?: (step: StepInfo) => void;
    /**
     * Decide a call the tool flagged with `needsApproval`. Without a handler
     * such a call is denied with a message — never silently run.
     */
    readonly onToolApproval?: (call: ToolApprovalCall, ctx: { readonly signal: AbortSignal }) => ToolApprovalDecision | Promise<ToolApprovalDecision>;
}

export interface StepInfo {
    readonly step: number;
    readonly finishReason: FinishReason;
    readonly usage?: Usage;
    readonly toolCalls: readonly { id: string; name: string; input: unknown }[];
}

function isUIMessages(messages: readonly UIMessage[] | readonly ModelMessage[]): messages is readonly UIMessage[] {
    // An empty transcript converts to an empty model conversation either way;
    // treating it as UI keeps every first-turn flow on the same path.
    const first = messages[0];
    return first === undefined || 'parts' in first;
}

/** A single model round, translated to UI chunks; returns what the loop needs. */
async function* runRound(
    model: LanguageModel,
    request: ModelRequest
): AsyncGenerator<UIChunk, RoundResult> {
    const content: ModelMessage & { role: 'assistant' } = { role: 'assistant', content: [] };
    const parts = content.content as Array<
        { type: 'text'; text: string } | { type: 'reasoning'; text: string; providerData?: unknown } | { type: 'tool-call'; id: string; name: string; input: unknown }
    >;
    const toolCalls: { id: string; name: string; input: unknown }[] = [];
    let finish: FinishReason = 'other';
    let usage: Usage | undefined;
    let errored: unknown;
    let sawFinish = false;

    const iterable = model.stream(request);
    const iterator = iterable[Symbol.asyncIterator]();
    try {
        for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            const ev: ModelEvent = next.value;
            switch (ev.type) {
                case 'text-delta': {
                    const last = parts[parts.length - 1];
                    if (last && last.type === 'text') last.text += ev.delta;
                    else parts.push({ type: 'text', text: ev.delta });
                    yield { type: 'text', delta: ev.delta };
                    break;
                }
                case 'reasoning-delta': {
                    const last = parts[parts.length - 1];
                    if (last && last.type === 'reasoning' && last.providerData === undefined) last.text += ev.delta;
                    else parts.push({ type: 'reasoning', text: ev.delta });
                    yield { type: 'reasoning', delta: ev.delta };
                    break;
                }
                case 'reasoning-end': {
                    const last = parts[parts.length - 1];
                    if (last && last.type === 'reasoning') {
                        if (ev.providerData !== undefined) last.providerData = ev.providerData;
                    } else if (ev.providerData !== undefined) {
                        // A provider that reports reasoning only as replay data (no text).
                        parts.push({ type: 'reasoning', text: '', providerData: ev.providerData });
                    }
                    yield ev.providerData !== undefined ? { type: 'reasoning-end', providerData: ev.providerData } : { type: 'reasoning-end' };
                    break;
                }
                case 'tool-input-delta':
                    // Progressive argument display is a later UI feature; the
                    // engine waits for the assembled call.
                    break;
                case 'tool-call':
                    parts.push({ type: 'tool-call', id: ev.id, name: ev.name, input: ev.input });
                    toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
                    yield { type: 'tool-call', id: ev.id, name: ev.name, input: ev.input };
                    break;
                case 'finish':
                    sawFinish = true;
                    finish = ev.reason;
                    usage = ev.usage;
                    break;
                case 'error':
                    errored = ev.error;
                    break;
            }
            if (errored !== undefined || sawFinish) break;
        }
    } finally {
        // Always close the provider iterator: a consumer that stopped early
        // releases the stream, and a generator paused on its `finish` yield
        // runs its cleanup now rather than never. Closing a finished
        // iterator is a no-op.
        await iterator.return?.();
    }
    if (errored !== undefined) throw errored instanceof Error ? errored : new Error(String(errored));
    if (toolCalls.length && finish !== 'tool') finish = 'tool';
    return { assistant: content, toolCalls, finish, usage };
}

interface RoundResult {
    readonly assistant: ModelMessage & { role: 'assistant' };
    readonly toolCalls: readonly { id: string; name: string; input: unknown }[];
    readonly finish: FinishReason;
    readonly usage: Usage | undefined;
}

/** A result already in the transcript (a resumed turn) — reused, not re-streamed. */
interface SettledResult {
    readonly output: unknown;
    readonly isError: boolean;
    readonly denied: boolean;
}

/** The round a resumed turn starts from: the transcript's last assistant message, decided by the client. */
interface ResumedRound extends RoundResult {
    readonly messageId: string;
    readonly settled: ReadonlyMap<string, SettledResult>;
    readonly approved: ReadonlySet<string>;
    readonly awaiting: ReadonlySet<string>;
}

/**
 * A UI transcript whose last message is an assistant turn with a call the
 * client has decided (`approved`) or that is still undecided (`awaiting`)
 * resumes at that turn's tool phase. Everything before it is the
 * conversation; its own settled calls are reused as results.
 */
function resumePoint(messages: readonly UIMessage[]): { head: readonly UIMessage[]; round: ResumedRound } | undefined {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return undefined;
    const toolParts = last.parts.filter((p): p is UIToolPart => p.type === 'tool');
    if (!toolParts.some((p) => p.state === 'approved' || p.state === 'awaiting')) return undefined;
    const settled = new Map<string, SettledResult>();
    const approved = new Set<string>();
    const awaiting = new Set<string>();
    for (const p of toolParts) {
        if (p.state === 'done' || p.state === 'error') settled.set(p.id, { output: p.output, isError: p.state === 'error', denied: false });
        else if (p.state === 'denied') settled.set(p.id, { output: p.output ?? DENIED_MESSAGE, isError: true, denied: true });
        else if (p.state === 'approved') approved.add(p.id);
        else if (p.state === 'awaiting') awaiting.add(p.id);
    }
    // `toModelMessages` of the one message yields its assistant content first
    // (the partial tool message after it is rebuilt in full once the calls settle).
    const [assistant] = toModelMessages([last]) as [ModelMessage & { role: 'assistant' }];
    return {
        head: messages.slice(0, -1),
        round: {
            assistant,
            toolCalls: toolParts.map((p) => ({ id: p.id, name: p.name, input: p.input })),
            finish: 'tool',
            usage: undefined,
            messageId: last.id,
            settled,
            approved,
            awaiting
        }
    };
}

type ToolOutcome =
    | { readonly call: { id: string; name: string }; readonly output: unknown; readonly isError: boolean; readonly denied?: true; readonly fromTranscript?: true }
    | { readonly call: { id: string; name: string }; readonly deferred: true };

/**
 * Stream one assistant turn as UI chunks. Runs the tool loop; ends with
 * exactly one `finish` (or one `error`).
 */
export async function* streamText(options: StreamTextOptions): AsyncGenerator<UIChunk, void, undefined> {
    const { model, tools, signal, onToolApproval } = options;
    // A finite integer ≥ 1; anything else (NaN, Infinity, a fraction) falls
    // back to the default rather than producing a loop that never runs.
    const maxSteps = Number.isFinite(options.maxSteps) ? Math.max(1, Math.floor(options.maxSteps as number)) : 5;
    const resume = isUIMessages(options.messages) ? resumePoint(options.messages) : undefined;
    const messages: ModelMessage[] = resume
        ? toModelMessages(resume.head)
        : isUIMessages(options.messages)
          ? toModelMessages(options.messages)
          : [...(options.messages as readonly ModelMessage[])];
    const specs = tools?.length ? tools.map((t) => t.spec) : undefined;
    // Tools always receive a signal; without a caller's, one inert signal serves the whole turn.
    const toolSignal = signal ?? new AbortController().signal;
    let usage: Usage | undefined;
    let finish: FinishReason = 'other';

    yield { type: 'start', messageId: resume?.round.messageId ?? options.messageId ?? generateId() };

    try {
        // The resumed round runs its tool phase before the first model round
        // of this turn; it counts as no step.
        let pending: ResumedRound | undefined = resume?.round;
        let step = 0;
        for (;;) {
            let round: RoundResult;
            let resumed: ResumedRound | undefined;
            if (pending) {
                round = resumed = pending;
                pending = undefined;
                messages.push(round.assistant);
            } else {
                if (signal?.aborted) throw abortError(signal);
                step++;
                const request: ModelRequest = {
                    messages,
                    ...(options.system !== undefined ? { system: options.system } : {}),
                    ...(specs ? { tools: specs } : {}),
                    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
                    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
                    ...(signal ? { signal } : {}),
                    ...(options.providerOptions ? { providerOptions: options.providerOptions } : {})
                };
                round = yield* runRound(model, request);
                usage = addUsage(usage, round.usage);
                finish = round.finish;
                options.onStep?.({ step, finishReason: round.finish, usage: round.usage, toolCalls: round.toolCalls });

                if (!round.toolCalls.length) break;
                messages.push(round.assistant);

                if (step === maxSteps) {
                    // Out of rounds with calls pending: report them unrun rather
                    // than silently dropping the model's request.
                    for (const call of round.toolCalls) {
                        yield { type: 'tool-result', id: call.id, output: `Tool "${call.name}" was not run: step limit (${maxSteps}) reached.`, isError: true };
                    }
                    finish = 'length';
                    break;
                }
            }

            // Phase 1 — who needs a human. Each gated call is announced before
            // any call runs, so the UI shows every pending decision at once.
            const gated = new Set<string>();
            const failedApproval = new Map<string, string>();
            for (const call of round.toolCalls) {
                if (resumed?.settled.has(call.id) || resumed?.approved.has(call.id)) continue;
                if (resumed?.awaiting.has(call.id)) {
                    gated.add(call.id);
                    yield { type: 'tool-approval-request', id: call.id };
                    continue;
                }
                const tool = findTool(tools, call.name);
                if (!tool?.approval) continue;
                try {
                    if (await abortable(signal, tool.approval(call.input, { signal: toolSignal, toolCallId: call.id }))) {
                        gated.add(call.id);
                        yield { type: 'tool-approval-request', id: call.id };
                    }
                } catch (e) {
                    if (isAbort(e)) throw e;
                    failedApproval.set(call.id, e instanceof Error ? e.message : String(e));
                }
            }

            // Phase 2 — every call of the round runs concurrently; results go
            // back in ONE message. An abort while they run ends the turn at
            // once — the tools hold `ctx.signal` and are expected to stop on
            // their own.
            const outcomes: ToolOutcome[] = await abortable(signal, Promise.all(
                round.toolCalls.map(async (call): Promise<ToolOutcome> => {
                    const settled = resumed?.settled.get(call.id);
                    if (settled) return { call, output: settled.output, isError: settled.isError, ...(settled.denied ? { denied: true as const } : {}), fromTranscript: true };
                    const tool = findTool(tools, call.name);
                    if (!tool) return { call, output: `Unknown tool "${call.name}".`, isError: true };
                    const approvalError = failedApproval.get(call.id);
                    if (approvalError !== undefined) return { call, output: approvalError, isError: true };
                    if (gated.has(call.id)) {
                        const decision = onToolApproval
                            ? await onToolApproval(call, { signal: toolSignal })
                            : ({ deny: `Tool "${call.name}" requires approval and no onToolApproval handler was supplied.` } as const);
                        if (decision === 'defer') return { call, deferred: true };
                        if (decision !== 'allow') {
                            return { call, output: decision === 'deny' ? `Tool "${call.name}" was denied.` : decision.deny, isError: true, denied: true };
                        }
                    }
                    try {
                        const output = await tool.run(call.input, { signal: toolSignal, toolCallId: call.id });
                        // The protocol is plain JSON: the result is normalized to
                        // its JSON form HERE, so an in-process consumer sees exactly
                        // what crosses the wire; a value that cannot serialize is a
                        // tool error now rather than a broken stream later.
                        const wire = toWireValue(output);
                        if (wire.error !== undefined) return { call, output: `Tool "${call.name}" returned a value that is not JSON-serializable: ${wire.error}`, isError: true };
                        return { call, output: wire.value, isError: false };
                    } catch (e) {
                        return { call, output: e instanceof Error ? e.message : String(e), isError: true };
                    }
                })
            ));
            if (signal?.aborted) throw abortError(signal);

            let deferred = false;
            for (const r of outcomes) {
                if ('deferred' in r) {
                    deferred = true;
                    continue;
                }
                // A result the client already holds is not streamed again.
                if (r.fromTranscript) continue;
                yield r.denied
                    ? { type: 'tool-result', id: r.call.id, output: r.output, isError: true, denied: true }
                    : r.isError
                      ? { type: 'tool-result', id: r.call.id, output: r.output, isError: true }
                      : { type: 'tool-result', id: r.call.id, output: r.output };
            }
            if (deferred) {
                // The client decides; the transcript keeps the assistant message
                // with its undecided calls and the next turn resumes here.
                finish = 'tool';
                break;
            }
            messages.push({
                role: 'tool',
                content: outcomes.map((r) => {
                    const settled = r as Extract<ToolOutcome, { output: unknown }>;
                    return {
                        type: 'tool-result',
                        toolCallId: settled.call.id,
                        toolName: settled.call.name,
                        output: settled.output,
                        ...(settled.isError ? { isError: true } : {})
                    };
                })
            });
        }
    } catch (e) {
        if (isAbort(e)) {
            yield { type: 'finish', reason: 'other', ...(usage ? { usage } : {}) };
            return;
        }
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
        return;
    }
    yield { type: 'finish', reason: finish, ...(usage ? { usage } : {}) };
}
