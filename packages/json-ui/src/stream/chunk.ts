/**
 * The stream protocol for a UI: how a spec arrives over time. Like
 * `UIChunk` in the core — flat, all-`readonly`, one line per member — and
 * folded by one reducer (`applyUIChunk`) on every side.
 *
 *   text*   — raw JSON deltas; the client re-parses the growing text
 *   spec    — a pre-parsed (possibly partial) document, merged in place
 *   patch   — changes to an already rendered spec, by node id
 *   finish | error — terminal
 */

import type { UIIssue, UIPatch, UISpec } from '../spec/types.js';

export type UIStreamChunk =
    | { readonly type: 'text'; readonly delta: string }
    | { readonly type: 'spec'; readonly spec: UISpec }
    | { readonly type: 'patch'; readonly patches: readonly UIPatch[] }
    | { readonly type: 'finish' }
    | { readonly type: 'error'; readonly message: string };

export type UIDocumentStatus = 'idle' | 'streaming' | 'done' | 'error';

/** A spec as the reducer holds it: the tree, the raw text so far, status and issues. Plain JSON. */
export interface UIDocument {
    spec: UISpec;
    text: string;
    status: UIDocumentStatus;
    error?: string;
    issues: UIIssue[];
}

export function createDocument(spec?: UISpec): UIDocument {
    return { spec: spec ?? {}, text: '', status: spec ? 'done' : 'idle', issues: [] };
}
