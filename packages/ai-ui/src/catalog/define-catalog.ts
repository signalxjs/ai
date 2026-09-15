/**
 * The catalog — the contract between the model and the renderer. It is
 * data only: what components exist, their props, events and children rule,
 * which actions and helpers a spec may use. The validator checks a spec
 * against it, the JSON Schema and the prompt section are generated from it,
 * and a platform pack implements it.
 */

import type { UINode } from '../spec/types.js';

export type PropType = 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'style' | 'any';

export interface PropSchema {
    readonly type: PropType;
    readonly required?: boolean;
    readonly description?: string;
    /** For `enum`. */
    readonly values?: readonly string[];
    /** For `object`. */
    readonly props?: Readonly<Record<string, PropSchema>>;
    /** For `array`. */
    readonly items?: PropSchema;
}

export interface EventDef {
    readonly description?: string;
    /** Fields of `$event`, by name and type, as the prompt shows them. */
    readonly payload?: Readonly<Record<string, PropType>>;
}

export interface ComponentDef {
    readonly description: string;
    readonly props?: Readonly<Record<string, PropSchema>>;
    readonly events?: Readonly<Record<string, EventDef>>;
    /** Whether the node may carry `children`. @default 'nodes' */
    readonly children?: 'none' | 'nodes';
    /** Supports `bind` (two-way value binding). */
    readonly bindable?: boolean;
    /** A short example node for the prompt. */
    readonly example?: UINode;
}

export interface ActionDef {
    readonly description: string;
    readonly args?: Readonly<Record<string, PropSchema>>;
    /** What `$result` holds afterwards. */
    readonly result?: string;
}

export interface HelperDef {
    /** As shown to the model: `where(list, predicate)`. */
    readonly signature: string;
    readonly description: string;
}

export interface UICatalog {
    readonly components: Readonly<Record<string, ComponentDef>>;
    readonly actions: Readonly<Record<string, ActionDef>>;
    readonly helpers: Readonly<Record<string, HelperDef>>;
}

export interface CatalogOptions {
    readonly components?: Readonly<Record<string, ComponentDef>>;
    readonly actions?: Readonly<Record<string, ActionDef>>;
    readonly helpers?: Readonly<Record<string, HelperDef>>;
    /** Start from another catalog (the base one, say) and add to it. */
    readonly extends?: UICatalog;
}

/** Props every component accepts, whatever its definition says. */
export const COMMON_PROPS: Readonly<Record<string, PropSchema>> = {
    style: { type: 'style', description: 'Inline style as an OBJECT of camelCase CSS properties (never a string).' },
    class: { type: 'string', description: 'Extra class names.' }
};

export function defineCatalog(options: CatalogOptions): UICatalog {
    const base = options.extends;
    return {
        components: { ...base?.components, ...options.components },
        actions: { ...base?.actions, ...options.actions },
        helpers: { ...base?.helpers, ...options.helpers }
    };
}

/** The prop schema for `name` on `component`, common props included. */
export function propSchema(component: ComponentDef, name: string): PropSchema | undefined {
    return component.props?.[name] ?? COMMON_PROPS[name];
}
