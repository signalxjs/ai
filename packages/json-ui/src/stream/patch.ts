/** `applyPatch` — one change to a rendered spec, addressed by node id. In place; an unknown id is an issue, not a throw. */

import { lvalue, type EvalEnv } from '../expr/index.js';
import { findNodeById } from '../spec/walk.js';
import type { UIIssue, UIPatch, UISpec } from '../spec/types.js';

const EMPTY_ENV: Omit<EvalEnv, 'state'> = { helpers: {} };

/** Apply `patch` to `spec`; `state` receives `state` patches (defaults to `spec.state`). Returns an issue when the patch could not apply. */
export function applyPatch(spec: UISpec, patch: UIPatch, state?: Record<string, unknown>): UIIssue | undefined {
    const path = ['patch', patch.op, 'id' in patch ? patch.id : patch.path];
    if (patch.op === 'state') {
        const target = state ?? (spec.state ??= {});
        const lv = lvalue(patch.path, undefined, { ...EMPTY_ENV, state: target }, true);
        if (!lv) return { path, message: `"${patch.path}" is not a writable path`, severity: 'error' };
        (lv.container as Record<string | number, unknown>)[lv.key] = patch.value;
        return undefined;
    }
    const at = findNodeById(spec, patch.id);
    if (!at) return { path, message: `no node with id "${patch.id}"`, severity: 'error' };
    switch (patch.op) {
        case 'replace':
            if (at.parent) at.parent.children![at.index] = patch.node;
            else spec.root = patch.node;
            return undefined;
        case 'append': {
            const children = (at.node.children ??= []);
            if (patch.index === undefined || patch.index >= children.length) children.push(patch.node);
            else children.splice(Math.max(0, patch.index), 0, patch.node);
            return undefined;
        }
        case 'remove':
            if (at.parent) at.parent.children!.splice(at.index, 1);
            else delete spec.root;
            return undefined;
        case 'props': {
            const props = (at.node.props ??= {});
            for (const k of Object.keys(patch.props)) props[k] = patch.props[k]!;
            return undefined;
        }
    }
}
