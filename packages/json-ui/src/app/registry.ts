/**
 * What a platform pack implements: one entry per catalog component, each a
 * sigx `component()` factory or a plain function of the evaluated props.
 * Both work with `jsx()` on every renderer, so a pack is just string tags —
 * `div` on the web, `view` on Lynx — and owns the event mapping, so a spec
 * stays platform-neutral (`on.press`, never `onClick` / `bindtap`).
 */

import type { JSXElement } from '@sigx/runtime-core';
import type { UINode } from '../spec/types.js';

/** A platform-neutral event as the spec sees it (`$event`). */
export interface UIEvent {
    readonly type: string;
    readonly value?: unknown;
    readonly [key: string]: unknown;
}

/** Two-way binding for a bindable component (`bind`). */
export interface UIModel {
    readonly value: unknown;
    set(value: unknown): void;
}

/**
 * The props a registry entry receives: the node's props, evaluated, plus
 * the reserved keys below. `on` holds one dispatcher per event the spec
 * bound; a pack calls `on.press?.({ type: 'press' })` after mapping the
 * platform event.
 */
export interface UIComponentProps {
    readonly [prop: string]: unknown;
    readonly children: JSXElement[];
    readonly on: Readonly<Record<string, (event?: UIEvent) => void>>;
    readonly model?: UIModel;
    /** `true` while an action started from this node is running. */
    readonly pending: boolean;
    /** The spec node (raw), for packs that need `id` or the like. */
    readonly node: UINode;
}

export type UIComponentImpl = ((props: UIComponentProps) => JSXElement) | { readonly __setup: unknown };

export type UIRegistry = Readonly<Record<string, UIComponentImpl>>;
