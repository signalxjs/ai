/** Step arguments → runtime values, through the expression language. */

import { resolveValue, type EvalEnv, type Scope } from '../expr/index.js';
import type { ActionStep } from '../spec/types.js';

/**
 * Keys that are not arguments (`do`, `if`, `else`, `as`, `catch`) or that a
 * handler evaluates itself, lazily: `steps` (nested lists) and `where` (a
 * per-item predicate).
 */
export const RAW_KEYS: ReadonlySet<string> = new Set(['do', 'if', 'else', 'as', 'catch', 'steps', 'where']);

const CONTROL_KEYS: ReadonlySet<string> = new Set(['do', 'if', 'else', 'as', 'catch']);

/** The step's arguments with every `{$}` / `{{}}` resolved in `scope`; raw keys pass through untouched. */
export function resolveArgs(step: ActionStep, scope: Scope | undefined, env: EvalEnv): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(step)) {
        if (CONTROL_KEYS.has(k)) continue;
        out[k] = RAW_KEYS.has(k) ? step[k] : resolveValue(step[k], scope, env);
    }
    return out;
}
