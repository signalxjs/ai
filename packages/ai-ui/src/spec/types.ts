/**
 * The UI spec — what a model writes and a renderer reads.
 *
 * Everything here is plain JSON: no classes, no functions, so a spec can be
 * streamed, stored, diffed and validated the same way on every side. A
 * dynamic value is either `{ "$": "expr" }` (typed) or a string carrying
 * `{{expr}}` interpolation; both use the expression language in `../expr`.
 */

/** A typed dynamic value: the expression's result is used as-is. */
export interface ExprValue {
    readonly $: string;
}

/** A prop value: JSON, or an expression, at any depth. */
export type Value = string | number | boolean | null | ExprValue | Value[] | { [key: string]: Value };

/** Repeat the node's `children` once per item of `items`. */
export interface UIFor {
    readonly items: ExprValue;
    /** Name the item is bound to in child scope. @default 'item' */
    readonly as?: string;
    /** Name the index is bound to in child scope. @default 'index' */
    readonly index?: string;
    /** Evaluated per item (in item scope) — a stable identity for reconciliation. */
    readonly key?: ExprValue;
}

/** How concurrent runs of the same node event relate. */
export type RunMode = 'drop' | 'restart' | 'queue' | 'parallel';

/**
 * One step of an action. `do` names a built-in (`state.set`, `http`, …),
 * a host action, or — through `call` — a named spec action. Every other key
 * is an argument, resolved through the expression language before the step
 * runs. `as` binds the result in the run's scope; `if` skips the step —
 * evaluated right before it, so it sees what earlier steps wrote — and
 * `else` runs instead when `if` is false; `catch` runs when the step throws
 * (with `$error` bound).
 */
export interface ActionStep {
    readonly do: string;
    readonly if?: ExprValue;
    readonly else?: ActionStep[];
    readonly as?: string;
    readonly catch?: ActionStep[];
    readonly [arg: string]: unknown;
}

export type EventBinding = ActionStep[] | { readonly steps: ActionStep[]; readonly mode?: RunMode };

export interface UINode {
    /** A catalog component name (`stack`, `text`, `button`, …). */
    type: string;
    /** Optional addressing handle for `ui.patch`. Not the reconciliation key. */
    id?: string;
    props?: Record<string, Value>;
    children?: UINode[];
    /** Render only when truthy. */
    if?: ExprValue;
    for?: UIFor;
    /** Two-way binding: an lvalue path into state or a loop item (`draft`, `form.email`, `todo.done`). */
    bind?: string;
    on?: Record<string, EventBinding>;
}

export interface UISpec {
    version?: 1;
    /** Initial runtime state; the runtime seeds from it and owns it from then on. */
    state?: Record<string, unknown>;
    /** Derived values, by name, readable from any expression. */
    computed?: Record<string, ExprValue>;
    /** Named step lists, run with `{ "do": "call", "action": "<name>" }`. */
    actions?: Record<string, ActionStep[]>;
    root?: UINode;
}

/** A change to an already rendered spec, addressed by node `id`. */
export type UIPatch =
    | { readonly op: 'replace'; readonly id: string; readonly node: UINode }
    | { readonly op: 'append'; readonly id: string; readonly node: UINode; readonly index?: number }
    | { readonly op: 'remove'; readonly id: string }
    | { readonly op: 'props'; readonly id: string; readonly props: Record<string, Value> }
    | { readonly op: 'state'; readonly path: string; readonly value: unknown };

export type UIIssueSeverity = 'error' | 'warning';

export interface UIIssue {
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
    readonly severity: UIIssueSeverity;
}

export function isExprValue(value: unknown): value is ExprValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as ExprValue).$ === 'string';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
