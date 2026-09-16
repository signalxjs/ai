/**
 * `UIView` — a spec on screen.
 *
 * Two ways to drive it. Hand it a `runtime` you own (fed with
 * `runtime.apply(chunk)` from any stream) and it renders that. Or hand it a
 * `spec` — the usual shape when the spec is a tool call's streaming
 * `input`: every new object that arrives in the prop is merged into the
 * view's own runtime in place, so the UI grows as the model writes it; flip
 * `done` to true when the call settles and the spec is validated.
 */

import { toRaw, watch } from '@sigx/reactivity';
import { component, onUnmounted, type JSXElement } from '@sigx/runtime-core';
import type { UISpec } from '../spec/types.js';
import type { UIRegistry } from './registry.js';
import { createUIRuntime, type UIRuntime, type UIRuntimeOptions } from './runtime.js';
import { nodeElement, type NodeContext } from './ui-node.js';

export interface UIViewProps extends UIRuntimeOptions {
    readonly registry: UIRegistry;
    /** A spec (or a partial one, mid-stream) — merged on every identity change. */
    readonly spec?: UISpec;
    /** With `spec`: `true` once the spec is complete. @default true */
    readonly done?: boolean;
    /** A runtime you drive yourself; `spec` and `done` are ignored. */
    readonly runtime?: UIRuntime;
    /** Rendered while the spec has no root yet. */
    readonly placeholder?: JSXElement;
    /** Receives the runtime once created (to run actions or read state from outside). */
    readonly onRuntime?: (runtime: UIRuntime) => void;
}

export const UIView = component<UIViewProps>(
    (ctx) => {
        const p = ctx.props;
        const own = !p.runtime;
        const runtime: UIRuntime =
            p.runtime ??
            createUIRuntime({
                catalog: p.catalog,
                actions: p.actions,
                helpers: p.helpers,
                state: p.state,
                onEmit: (name, payload) => ctx.props.onEmit?.(name, payload),
                onActionError: p.onActionError ? (e, at) => ctx.props.onActionError?.(e, at) : undefined,
                http: p.http
            });
        p.onRuntime?.(runtime);

        if (own) {
            let finished = false;
            const feed = (spec: UISpec | undefined, done: boolean | undefined): void => {
                if (spec) runtime.apply({ type: 'spec', spec: toRaw(spec) as UISpec });
                if ((done ?? true) && !finished) {
                    finished = true;
                    runtime.apply({ type: 'finish' });
                } else if (done === false) finished = false;
            };
            feed(p.spec, p.done);
            // Identity-based: a streaming source hands over a new object per token.
            watch(
                () => [ctx.props.spec, ctx.props.done] as const,
                ([spec, done]) => feed(spec, done)
            );
            onUnmounted(() => runtime.dispose());
        }

        return () => {
            // Only the root's identity is read here; everything below is a keyed UINodeView with its own thunk.
            const root = runtime.doc.spec.root;
            if (!root || typeof root !== 'object') return ctx.props.placeholder ?? null;
            const c: NodeContext = { runtime, registry: ctx.props.registry, scope: runtime.rootScope };
            return nodeElement(root, c);
        };
    },
    { name: 'UIView' }
);
