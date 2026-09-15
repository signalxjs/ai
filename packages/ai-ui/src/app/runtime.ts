/**
 * `createUIRuntime` — a spec as live state: the reactive document the
 * stream reducer folds into, the runtime state (seeded from `spec.state`,
 * owned by the runtime from then on), lazily created `computed` signals, the
 * action runner, and per-node event runs with their concurrency modes.
 *
 * Renderer-neutral: only `@sigx/reactivity` here. `UIView` renders it.
 */

import { batch, computed, signal, toRaw, untrack, type Computed } from '@sigx/reactivity';
import { anySignal, createActionRunner, type ActionErrorSite, type ActionRunner, type ActionTable, type HttpOptions, type RunOptions, type RunResult } from '../actions/index.js';
import { baseCatalog, type UICatalog } from '../catalog/index.js';
import { childScope, defaultHelpers, evaluateSource, type EvalEnv, type HelperTable, type Scope } from '../expr/index.js';
import type { ActionStep, EventBinding, RunMode, UINode, UISpec } from '../spec/types.js';
import { applyUIChunk, createDocument, type UIDocument, type UIStreamChunk } from '../stream/index.js';
import type { UIEvent } from './registry.js';

export interface UIRuntimeOptions {
    /** @default baseCatalog */
    readonly catalog?: UICatalog;
    /** Host actions, merged over the built-ins. */
    readonly actions?: ActionTable;
    /** Extra expression helpers, merged over the defaults. */
    readonly helpers?: HelperTable;
    /** Initial state the host contributes; `spec.state` fills in the rest. */
    readonly state?: Record<string, unknown>;
    readonly onEmit?: (name: string, payload: unknown) => void;
    readonly onActionError?: (error: Error, at: ActionErrorSite) => void;
    readonly http?: HttpOptions;
}

export interface UIRuntime {
    /** The document — reactive; `doc.spec` is the tree the view renders. */
    readonly doc: UIDocument;
    /** Runtime state — reactive; what expressions read and actions write. */
    readonly state: Record<string, unknown>;
    readonly catalog: UICatalog;
    readonly env: EvalEnv;
    readonly rootScope: Scope;
    /** Aborts every running action when the runtime is disposed. */
    readonly signal: AbortSignal;
    /** Fold a chunk into the document (and seed state from `spec.state`). Returns `true` on a terminal chunk. */
    apply(chunk: UIStreamChunk): boolean;
    /** Run steps outside any node event (a host button, say). */
    run(steps: readonly ActionStep[], scope?: Scope, options?: RunOptions): Promise<RunResult>;
    /** Dispatch a node event: applies the binding's concurrency mode and tracks `$pending`. */
    dispatch(node: UINode, event: string, binding: EventBinding, scope: Scope, payload?: UIEvent): void;
    /** Reactive: `true` while an action from `node` is running. */
    pending(node: UINode): boolean;
    dispose(): void;
}

const DEFAULT_MODES: Readonly<Record<string, RunMode>> = { input: 'restart', change: 'restart' };

interface EventEntry {
    controller: AbortController;
    running: number;
    queue: Promise<unknown>;
}

export function createUIRuntime(options: UIRuntimeOptions = {}): UIRuntime {
    const catalog = options.catalog ?? baseCatalog;
    const doc = signal(createDocument()) as UIDocument;
    const state = signal({ ...options.state }) as Record<string, unknown>;
    const controller = new AbortController();
    const computeds = new Map<string, Computed<unknown>>();
    const helpers: HelperTable = { ...defaultHelpers, ...options.helpers };
    const rootScope: Scope = { vars: {} };

    const env: EvalEnv = {
        helpers,
        state,
        lookup(name) {
            // Tracked read: a computed that appears (or changes) later re-runs its readers.
            const def = doc.spec.computed?.[name];
            if (!def) return undefined;
            let c = computeds.get(name);
            if (!c) {
                c = computed(() => {
                    const source = doc.spec.computed?.[name]?.$;
                    return typeof source === 'string' ? evaluateSource(source, rootScope, env) : undefined;
                });
                computeds.set(name, c);
            }
            return c.value;
        }
    };

    const runner: ActionRunner = createActionRunner({
        env,
        actions: options.actions,
        spec: () => toRaw(doc).spec as UISpec,
        patchUI: (patches) => {
            apply({ type: 'patch', patches });
        },
        emit: (name, payload) => options.onEmit?.(name, payload),
        http: options.http,
        onError: (error, at) => {
            if (options.onActionError) options.onActionError(error, at);
            else if (__DEV__) console.error('[sigx ai-ui] action failed:', error, at.step);
        }
    });

    /** Keys of `spec.state` not yet in the runtime state get their initial value; existing keys are never touched. */
    function seedState(): void {
        const initial = (toRaw(doc).spec as UISpec).state;
        if (!initial || typeof initial !== 'object') return;
        const raw = toRaw(state);
        for (const k of Object.keys(initial)) {
            if (k.startsWith('$') || k === '__proto__' || Object.prototype.hasOwnProperty.call(raw, k)) continue;
            const v = initial[k];
            state[k] = typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
        }
    }

    function apply(chunk: UIStreamChunk): boolean {
        let ended = false;
        untrack(() =>
            batch(() => {
                ended = applyUIChunk(doc, chunk, { catalog, state });
                seedState();
            })
        );
        return ended;
    }

    const entries = new WeakMap<object, Map<string, EventEntry>>();
    const pendingCounts = new WeakMap<object, { value: number }>();

    function pendingOf(node: UINode): { value: number } {
        const raw = toRaw(node);
        let p = pendingCounts.get(raw);
        if (!p) {
            p = signal(0);
            pendingCounts.set(raw, p);
        }
        return p;
    }

    function entryOf(node: UINode, event: string): EventEntry {
        const raw = toRaw(node);
        let map = entries.get(raw);
        if (!map) {
            map = new Map();
            entries.set(raw, map);
        }
        let entry = map.get(event);
        if (!entry) {
            entry = { controller: new AbortController(), running: 0, queue: Promise.resolve() };
            map.set(event, entry);
        }
        return entry;
    }

    function dispatch(node: UINode, event: string, binding: EventBinding, scope: Scope, payload?: UIEvent): void {
        if (controller.signal.aborted) return;
        const steps = Array.isArray(binding) ? binding : binding.steps;
        const mode: RunMode = (Array.isArray(binding) ? undefined : binding.mode) ?? DEFAULT_MODES[event] ?? 'drop';
        const entry = entryOf(node, event);
        if (mode === 'drop' && entry.running > 0) return;
        if (mode === 'restart' && entry.running > 0) {
            entry.controller.abort(new Error('superseded'));
            entry.controller = new AbortController();
        }
        const runScope = childScope(scope, { $event: payload ?? { type: event } });
        const pending = pendingOf(node);
        const start = (): Promise<unknown> => {
            const own = entry.controller;
            const { signal } = anySignal([controller.signal, own.signal]);
            entry.running++;
            pending.value++;
            return runner.run(steps, runScope, { signal, node: toRaw(node), event }).finally(() => {
                entry.running--;
                pending.value--;
            });
        };
        if (mode === 'queue') entry.queue = entry.queue.then(start, start);
        else void start();
    }

    return {
        doc,
        state,
        catalog,
        env,
        rootScope,
        signal: controller.signal,
        apply,
        run: (steps, scope, runOptions) => runner.run(steps, scope ?? rootScope, { ...runOptions, signal: runOptions?.signal ? anySignal([controller.signal, runOptions.signal]).signal : controller.signal }),
        dispatch,
        pending: (node) => pendingOf(node).value > 0,
        dispose: () => controller.abort(new Error('disposed'))
    };
}
