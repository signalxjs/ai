/** The action runtime's contracts — what a handler receives, what a runner is built from. */

import type { EvalEnv, Scope } from '../expr/index.js';
import type { ActionStep, UINode, UIPatch, UISpec } from '../spec/types.js';

export interface UIActionContext {
    /** The runtime state object. */
    readonly state: Record<string, unknown>;
    /** The run's scope: `$event`, `$result`, `$error`, `$args`, loop variables, `as` bindings. */
    readonly scope: Scope;
    readonly env: EvalEnv;
    /** Aborts when the view unmounts or the run is superseded. */
    readonly signal: AbortSignal;
    /** The node whose event started this run, when any. */
    readonly node?: UINode;
    readonly event?: string;
    /** Evaluate an expression source in the run's scope. Throws on a parse error. */
    evaluate(source: string): unknown;
    /** Resolve a spec value (`{$}`, `{{}}`, nested) in the run's scope. */
    resolve(value: unknown): unknown;
    /** Run steps as part of this run (a nested list shares the abort signal). Rejects on failure. */
    run(steps: readonly ActionStep[], scope?: Scope): Promise<unknown>;
    patchUI(patches: readonly UIPatch[]): void;
    emit(name: string, payload: unknown): void;
    /** Report a state write (`root` is the top-level key, `undefined` for a loop item), so a streaming spec stops re-seeding it. */
    touch(root: string | undefined): void;
}

export type ActionHandler = (args: Record<string, unknown>, ctx: UIActionContext) => unknown | Promise<unknown>;
export type ActionTable = Readonly<Record<string, ActionHandler>>;

export interface HttpOptions {
    /**
     * Hosts an absolute URL may target (`api.example.com`, `*.example.com`).
     * Relative URLs (same origin) are always allowed; with no list, absolute
     * URLs are refused.
     */
    readonly allowHosts?: readonly string[];
    readonly fetch?: typeof fetch;
    /** Resolves relative URLs outside a browser. */
    readonly baseUrl?: string;
    /** Milliseconds before a request is aborted. @default 30000 */
    readonly timeoutMs?: number;
}

export interface ActionErrorSite {
    readonly node?: UINode;
    readonly step?: ActionStep;
    readonly event?: string;
}

export interface ActionRunnerOptions {
    readonly env: EvalEnv;
    /** Host actions; merged over the built-ins (a host may override one). */
    readonly actions?: ActionTable;
    /** The current spec — `call` reads `spec.actions` from it. */
    readonly spec: () => UISpec;
    readonly patchUI?: (patches: readonly UIPatch[]) => void;
    readonly emit?: (name: string, payload: unknown) => void;
    readonly http?: HttpOptions;
    /** Every state write by an action, by top-level key (`undefined` for a loop item). */
    readonly onWrite?: (root: string | undefined) => void;
    /** Every failed run lands here; runs never reject into the event loop. */
    readonly onError?: (error: Error, at: ActionErrorSite) => void;
}

export interface RunOptions {
    readonly signal?: AbortSignal;
    readonly node?: UINode;
    readonly event?: string;
}

export type RunResult = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: Error; readonly aborted: boolean };

export interface ActionRunner {
    /** Run a step list. Resolves with the outcome; a failure is reported to `onError` and returned, never thrown. */
    run(steps: readonly ActionStep[], scope?: Scope, options?: RunOptions): Promise<RunResult>;
    readonly actions: ActionTable;
}

export class UIActionError extends Error {
    readonly step?: ActionStep;
    constructor(message: string, step?: ActionStep, cause?: unknown) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = 'UIActionError';
        this.step = step;
    }
}
