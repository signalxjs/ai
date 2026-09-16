/**
 * `applyUIChunk` — fold one stream chunk into a document IN PLACE. Works on
 * a plain document and on a reactive one alike; the app hands it the
 * proxied document so a token into a text prop is one property write.
 *
 * Returns `true` when the chunk ended the stream (`finish` / `error`).
 */

import { parsePartialJson } from '../utils/partial-json.js';
import { batch, toRaw, untrack } from '@sigx/reactivity';
import { validateSpec } from '../catalog/index.js';
import type { UICatalog } from '../catalog/index.js';
import { isPlainObject, type UISpec } from '../spec/types.js';
import type { UIDocument, UIStreamChunk } from './chunk.js';
import { mergeDeep } from './merge.js';
import { applyPatch } from './patch.js';

export interface ReduceOptions {
    /** Validated against at `finish`; without one no issues are produced. */
    readonly catalog?: UICatalog;
    /** Where `state` patches land; defaults to `spec.state`. */
    readonly state?: Record<string, unknown>;
}

export function applyUIChunk(doc: UIDocument, chunk: UIStreamChunk, options: ReduceOptions = {}): boolean {
    return untrack(() => {
        let ended = false;
        batch(() => {
            switch (chunk.type) {
                case 'text': {
                    doc.text += chunk.delta;
                    if (doc.status !== 'done') doc.status = 'streaming';
                    const parsed = parsePartialJson(doc.text);
                    if (isPlainObject(parsed)) mergeDeep(doc.spec as Record<string, unknown>, parsed);
                    break;
                }
                case 'spec':
                    if (doc.status === 'idle') doc.status = 'streaming';
                    mergeDeep(doc.spec as Record<string, unknown>, chunk.spec);
                    break;
                case 'patch':
                    for (const patch of chunk.patches) {
                        const issue = applyPatch(doc.spec, patch, options.state);
                        if (issue) doc.issues.push(issue);
                    }
                    break;
                case 'finish': {
                    if (doc.text) {
                        let final: unknown;
                        try {
                            final = JSON.parse(doc.text);
                        } catch {
                            final = parsePartialJson(doc.text);
                        }
                        if (isPlainObject(final)) mergeDeep(doc.spec as Record<string, unknown>, final);
                    }
                    if (options.catalog) doc.issues = validateSpec(toRaw(doc.spec) as UISpec, options.catalog, { mode: 'final' });
                    doc.status = 'done';
                    ended = true;
                    break;
                }
                case 'error':
                    doc.status = 'error';
                    doc.error = chunk.message;
                    ended = true;
                    break;
            }
        });
        return ended;
    });
}

/** Drain a chunk stream into a document. */
export async function assembleSpec(chunks: AsyncIterable<UIStreamChunk>, into: UIDocument, options?: ReduceOptions): Promise<UIDocument> {
    for await (const chunk of chunks) {
        if (applyUIChunk(into, chunk, options)) break;
    }
    return into;
}
