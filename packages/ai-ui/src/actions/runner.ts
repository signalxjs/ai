/**
 * `createActionRunner` — runs step lists: sequential, each step awaited,
 * arguments resolved in the run's scope, `if` / `as` / `catch` honoured,
 * every cancellation an `AbortError` that stops the run without a state
 * write. A run never rejects into the event loop: `run()` resolves with the
 * outcome and reports failures to `onError`; nested runs (`ctx.run`) do
 * reject, so a `catch` on a `seq` covers the whole group.
 */

import { untrack } from '@sigx/reactivity';
import { childScope, evaluateSource, resolveValue, truthy, type Scope } from '../expr/index.js';
import type { ActionStep, UIPatch } from '../spec/types.js';
import { abortError, isAbort } from './abort.js';
import { builtinActions } from './builtins.js';
import { resolveArgs } from './resolve.js';
import { UIActionError, type ActionRunner, type ActionRunnerOptions, type ActionTable, type RunOptions, type UIActionContext } from './types.js';

const NEVER_ABORTS = new AbortController().signal;

export function createActionRunner(options: ActionRunnerOptions): ActionRunner {
    const actions: ActionTable = { ...builtinActions({ spec: options.spec, http: options.http }), ...options.actions };
    const env = options.env;

    async function execute(steps: readonly ActionStep[], scope: Scope, run: RunOptions & { readonly signal: AbortSignal }): Promise<unknown> {
        for (const step of steps) {
            if (run.signal.aborted) throw abortError(run.signal);
            if (!step || typeof step !== 'object' || typeof step.do !== 'string') throw new UIActionError('a step must be { "do": "<action>", … }', step);
            if (step.if !== undefined) {
                const cond = untrack(() => evaluateSource(step.if!.$, scope, env, true));
                if (!truthy(cond)) continue;
            }
            const handler = Object.prototype.hasOwnProperty.call(actions, step.do) ? actions[step.do] : undefined;
            if (!handler) throw new UIActionError(`unknown action "${step.do}"`, step);
            const ctx: UIActionContext = {
                state: env.state,
                scope,
                env,
                signal: run.signal,
                node: run.node,
                event: run.event,
                evaluate: (source) => untrack(() => evaluateSource(source, scope, env, true)),
                resolve: (value) => untrack(() => resolveValue(value, scope, env)),
                run: (nested, nestedScope) => execute(nested, nestedScope ?? scope, run),
                patchUI: (patches: readonly UIPatch[]) => options.patchUI?.(patches),
                emit: (name, payload) => options.emit?.(name, payload)
            };
            try {
                const args = untrack(() => resolveArgs(step, scope, env));
                const result = await handler(args, ctx);
                if (run.signal.aborted) throw abortError(run.signal);
                scope.vars.$result = result;
                if (typeof step.as === 'string' && step.as) scope.vars[step.as] = result;
            } catch (e) {
                if (isAbort(e)) throw e;
                const error = e instanceof Error ? e : new Error(String(e));
                if (!Array.isArray(step.catch)) throw error instanceof UIActionError ? error : new UIActionError(`${step.do}: ${error.message}`, step, error);
                scope.vars.$error = { message: error.message, name: error.name };
                await execute(step.catch, scope, run);
            }
        }
        return scope.vars.$result;
    }

    return {
        actions,
        async run(steps, scope, runOptions = {}) {
            const signal = runOptions.signal ?? NEVER_ABORTS;
            const runScope = childScope(scope, { $result: undefined });
            try {
                const result = await execute(steps, runScope, { ...runOptions, signal });
                return { ok: true, result };
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                const aborted = isAbort(error);
                if (!aborted) {
                    const step = error instanceof UIActionError ? error.step : undefined;
                    options.onError?.(error, { node: runOptions.node, step, event: runOptions.event });
                }
                return { ok: false, error, aborted };
            }
        }
    };
}
