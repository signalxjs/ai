/** Tree helpers over a spec — no reactivity, no rendering. */

import type { UINode, UISpec } from './types.js';

export interface NodeLocation {
    /** `undefined` for the root. */
    readonly parent: UINode | undefined;
    /** Index in `parent.children`, or -1 for the root. */
    readonly index: number;
    readonly node: UINode;
    readonly path: ReadonlyArray<string | number>;
}

/** Depth-first, parents before children. Return `false` from `fn` to stop. */
export function visit(root: UINode | undefined, fn: (node: UINode, path: ReadonlyArray<string | number>) => boolean | void): void {
    if (!root) return;
    const stack: { node: UINode; path: (string | number)[] }[] = [{ node: root, path: ['root'] }];
    while (stack.length) {
        const { node, path } = stack.pop()!;
        if (fn(node, path) === false) return;
        const children = node.children;
        if (Array.isArray(children)) {
            for (let i = children.length - 1; i >= 0; i--) {
                const child = children[i];
                if (typeof child === 'object' && child !== null) stack.push({ node: child, path: [...path, 'children', i] });
            }
        }
    }
}

/** The first node carrying `id`, with its parent and index. */
export function findNodeById(spec: UISpec, id: string): NodeLocation | undefined {
    const root = spec.root;
    if (!root) return undefined;
    if (root.id === id) return { parent: undefined, index: -1, node: root, path: ['root'] };
    const stack: { node: UINode; path: (string | number)[] }[] = [{ node: root, path: ['root'] }];
    while (stack.length) {
        const { node, path } = stack.pop()!;
        const children = node.children;
        if (!Array.isArray(children)) continue;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (typeof child !== 'object' || child === null) continue;
            const childPath = [...path, 'children', i];
            if (child.id === id) return { parent: node, index: i, node: child, path: childPath };
            stack.push({ node: child, path: childPath });
        }
    }
    return undefined;
}
