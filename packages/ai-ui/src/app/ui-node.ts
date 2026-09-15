/**
 * `UINodeView` — one spec node as a sigx component. Its render thunk reads
 * the node's `type`, `if`, `props`, `for`, `bind`, `on` and `children`
 * through the reactive document, so a token written into `props.text`
 * re-runs this node's thunk and nothing else; a child pushed onto
 * `children` re-runs the parent, whose keyed children keep their instances.
 *
 * Props: `node` (the reactive spec node) and `ctx`, a function returning
 * the node's context — a function so the props proxy leaves it alone. The
 * context is cached per (scope, raw node), so it is stable across renders.
 */

import { toRaw } from '@sigx/reactivity';
import { component, jsx, type JSXElement } from '@sigx/runtime-core';
import { childScope, evaluateSource, lvalue, resolveValue, truthy, type Scope } from '../expr/index.js';
import type { UINode } from '../spec/types.js';
import { keyOf } from './keys.js';
import type { UIComponentProps, UIEvent, UIModel, UIRegistry } from './registry.js';
import type { UIRuntime } from './runtime.js';

export interface NodeContext {
    readonly runtime: UIRuntime;
    readonly registry: UIRegistry;
    readonly scope: Scope;
}

const contexts = new WeakMap<Scope, WeakMap<object, () => NodeContext>>();

/** A stable context getter for `node` under `scope`. */
export function contextFor(runtime: UIRuntime, registry: UIRegistry, scope: Scope, node: UINode): () => NodeContext {
    let byNode = contexts.get(scope);
    if (!byNode) {
        byNode = new WeakMap();
        contexts.set(scope, byNode);
    }
    const raw = toRaw(node);
    let get = byNode.get(raw);
    if (!get) {
        const ctx: NodeContext = { runtime, registry, scope };
        get = () => ctx;
        byNode.set(raw, get);
    }
    return get;
}

/** The element for a child node — keyed by identity so streaming siblings never remount it. */
export function nodeElement(node: UINode, ctx: NodeContext, keyPrefix = ''): JSXElement {
    return jsx(UINodeView, { node, ctx: contextFor(ctx.runtime, ctx.registry, ctx.scope, node) }, keyPrefix + keyOf(toRaw(node)));
}

const itemScopes = new WeakMap<Scope, WeakMap<object, Scope>>();

/** The scope for one `for` item — cached per raw item so a re-render reuses it (and so do the item's node contexts). */
function scopeForItem(parent: Scope, item: unknown, index: number, as: string, indexName: string): Scope {
    if (typeof item !== 'object' || item === null) return childScope(parent, { [as]: item, [indexName]: index });
    let byItem = itemScopes.get(parent);
    if (!byItem) {
        byItem = new WeakMap();
        itemScopes.set(parent, byItem);
    }
    const raw = toRaw(item);
    let scope = byItem.get(raw);
    if (!scope) {
        scope = childScope(parent, { [as]: item, [indexName]: index });
        byItem.set(raw, scope);
    } else scope.vars[indexName] = index;
    return scope;
}

const warned = new Set<string>();

export function renderNode(node: UINode, ctx: NodeContext): JSXElement {
    const { runtime, registry, scope } = ctx;
    const env = runtime.env;
    if (node.if !== undefined && !truthy(evaluateSource(node.if.$, scope, env))) return null;
    const type = node.type;
    const impl = typeof type === 'string' ? registry[type] : undefined;
    if (!impl) {
        if (__DEV__ && typeof type === 'string' && runtime.doc.status === 'done' && !warned.has(type)) {
            warned.add(type);
            console.warn(`[sigx ai-ui] no component registered for "${type}"`);
        }
        return null;
    }

    const evaluated: Record<string, unknown> = {};
    const specProps = node.props;
    if (specProps && typeof specProps === 'object') {
        for (const k of Object.keys(specProps)) {
            if (k === 'children' || k === 'on' || k === 'model' || k === 'pending' || k === 'node' || k === 'key' || k === 'ref') continue;
            evaluated[k] = resolveValue(specProps[k], scope, env);
        }
    }

    const children: JSXElement[] = [];
    const specChildren = Array.isArray(node.children) ? node.children : undefined;
    if (node.for && typeof node.for === 'object' && node.for.items) {
        const items = evaluateSource(node.for.items.$, scope, env);
        if (Array.isArray(items) && specChildren) {
            const as = typeof node.for.as === 'string' ? node.for.as : 'item';
            const indexName = typeof node.for.index === 'string' ? node.for.index : 'index';
            const keyExpr = node.for.key?.$;
            const seen = new Set<string>();
            items.forEach((item, i) => {
                const itemScope = scopeForItem(scope, item, i, as, indexName);
                let key = keyExpr ? String(evaluateSource(keyExpr, itemScope, env) ?? '') : typeof item === 'object' && item !== null ? keyOf(toRaw(item)) : String(i);
                if (!key || seen.has(key)) key = `${key}#${i}`;
                seen.add(key);
                const itemCtx: NodeContext = { runtime, registry, scope: itemScope };
                specChildren.forEach((child, c) => {
                    if (child && typeof child === 'object') children.push(nodeElement(child, itemCtx, `${key}/${c}:`));
                });
            });
        }
    } else if (specChildren) {
        for (const child of specChildren) if (child && typeof child === 'object') children.push(nodeElement(child, ctx));
    }

    const on: Record<string, (event?: UIEvent) => void> = {};
    const bindings = node.on;
    if (bindings && typeof bindings === 'object') {
        for (const event of Object.keys(bindings)) {
            const binding = bindings[event]!;
            on[event] = (payload) => runtime.dispatch(node, event, binding, scope, payload ?? { type: event });
        }
    }

    let model: UIModel | undefined;
    const bind = node.bind;
    if (typeof bind === 'string' && bind) {
        // Read without creating: a render must not write state. `set` creates the path on first write.
        const lv = lvalue(bind, scope, env, false);
        const value = lv ? (lv.container as Record<string | number, unknown>)[lv.key] : undefined;
        model = {
            value,
            set(v) {
                const target = lvalue(bind, scope, env, true);
                if (target) (target.container as Record<string | number, unknown>)[target.key] = v;
            }
        };
    }

    const props: UIComponentProps = { ...evaluated, children, on, model, pending: runtime.pending(node), node: toRaw(node) };
    return jsx(impl as (p: UIComponentProps) => JSXElement, props as unknown as Record<string, unknown>);
}

export const UINodeView = component<{ node: UINode; ctx: () => NodeContext }>((c) => () => renderNode(c.props.node, c.props.ctx()), { name: 'UINode' });
