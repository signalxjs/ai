/**
 * @sigx/json-ui/app — the renderer.
 *
 * Built on `@sigx/runtime-core` and `@sigx/reactivity`, never the `sigx`
 * umbrella (which drags the DOM renderer in), so a Lynx app uses it with
 * its own component pack.
 */

export type { UIEvent, UIModel, UIComponentProps, UIComponentImpl, UIRegistry } from './registry.js';
export type { UIRuntime, UIRuntimeOptions } from './runtime.js';
export { createUIRuntime } from './runtime.js';
export type { UIViewProps } from './ui-view.js';
export { UIView } from './ui-view.js';
export type { NodeContext } from './ui-node.js';
export { UINodeView, renderNode } from './ui-node.js';
export type { UISpec, UINode, UIStreamChunk, UIDocument, UIIssue } from '../index.js';
