/**
 * `useObject` — a streaming JSON document as a reactive partial.
 *
 * The source yields chunks (`streamObject` on the server, or any text
 * stream); each text delta is re-parsed with `parsePartialJson` and the
 * result is merged into ONE reactive proxy key by key — a key whose value
 * did not change is not written, so a view reading `object.title` re-runs
 * only when the title grows.
 *
 * Client-driven: nothing runs until `run(input)`; a running parse is
 * superseded by the next `run()` or `stop()`, `useAction`-style.
 */

import { signal, batch, untrack } from '@sigx/reactivity';
import { getCurrentInstance } from '@sigx/runtime-core';
import { parsePartialJson } from '../utils/partial-json.js';
import type { UIChunk } from '../protocol/index.js';
import type { ObjectChunk } from '../engine/index.js';
import { validateWith, type StandardSchemaV1 } from '../schema/index.js';

/** What the source may yield: UI chunks, `streamObject`'s object chunks, or raw text. */
export type ObjectSourceChunk = UIChunk | ObjectChunk<unknown> | string;

export type ObjectStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface UseObjectOptions<S extends StandardSchemaV1, In> {
    /** Validates the FINAL document; the partial is untyped until then. */
    readonly schema?: S;
    readonly stream: (input: In) => AsyncIterable<ObjectSourceChunk>;
    readonly onFinish?: (object: StandardSchemaV1.InferOutput<S>) => void;
    readonly onError?: (error: Error) => void;
}

export interface StreamedObject<T, In> {
    /** The partial document — reactive, grows key by key. */
    readonly object: Partial<T>;
    readonly status: ObjectStatus;
    readonly error: Error | null;
    /** The raw text so far. */
    readonly text: string;
    run(input: In): Promise<void>;
    stop(): void;
    reset(): void;
}

/** With a schema: the final document — and `onFinish` — are typed by it. */
export function useObject<S extends StandardSchemaV1, In = void>(
    options: UseObjectOptions<S, In> & { readonly schema: S }
): StreamedObject<StandardSchemaV1.InferOutput<S>, In>;
/** Without a schema: nothing is validated, so the document is `unknown`. */
export function useObject<In = void>(
    options: Omit<UseObjectOptions<StandardSchemaV1, In>, 'schema' | 'onFinish'> & {
        readonly schema?: undefined;
        readonly onFinish?: (object: unknown) => void;
    }
): StreamedObject<unknown, In>;
export function useObject<S extends StandardSchemaV1, In = void>(
    options: UseObjectOptions<S, In>
): StreamedObject<StandardSchemaV1.InferOutput<S>, In> {
    const instance = getCurrentInstance();
    if (!instance) {
        throw new Error('[sigx ai] useObject() must be called inside component setup.');
    }
    type T = StandardSchemaV1.InferOutput<S>;
    // The document is its own top-level object signal so `$set({})` (reset)
    // is typed; status/text live beside it.
    const object = signal({} as Record<string, unknown>);
    const state = signal({
        status: 'idle' as ObjectStatus,
        error: null as Error | null,
        text: ''
    });
    let seq = 0;
    let current: AsyncIterator<ObjectSourceChunk> | null = null;

    function stopCurrent(): void {
        seq++;
        const it = current;
        current = null;
        if (it) void it.return?.().catch(() => {});
    }

    function merge(parsed: unknown): void {
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        const next = parsed as Record<string, unknown>;
        untrack(() =>
            batch(() => {
                for (const [k, v] of Object.entries(next)) {
                    if (!sameJson(object[k], v)) object[k] = v;
                }
            })
        );
    }

    async function run(input: In): Promise<void> {
        stopCurrent();
        const id = seq;
        untrack(() =>
            batch(() => {
                object.$set({});
                state.status = 'streaming';
                state.error = null;
                state.text = '';
            })
        );
        let text = '';
        try {
            const it = options.stream(input)[Symbol.asyncIterator]();
            current = it;
            for (;;) {
                const next = await it.next();
                if (id !== seq) return;
                if (next.done) break;
                const chunk = next.value;
                // `streamObject`'s own partials are redundant with the text
                // parse here (the text is the source of truth on this side).
                if (typeof chunk === 'object' && chunk.type === 'object') continue;
                const delta = typeof chunk === 'string' ? chunk : chunk.type === 'text' ? chunk.delta : chunk.type === 'error' ? raise(chunk.message) : '';
                if (!delta) continue;
                text += delta;
                untrack(() => { state.text = text; });
                merge(parsePartialJson(text));
            }
            if (id !== seq) return;
            current = null;
            let final: unknown = parsePartialJson(text);
            // A stream that never produced parseable JSON is a failure, not an
            // empty success — with or without a schema.
            if (final === undefined) throw new Error('[sigx ai] useObject: the stream produced no parseable JSON.');
            // The reactive `object` is a JSON OBJECT; an array or a primitive
            // at the top level has nowhere to go and would leave `object` as
            // `{}` while onFinish received something else.
            if (typeof final !== 'object' || final === null || Array.isArray(final)) {
                throw new Error(`[sigx ai] useObject: expected a JSON object at the top level, got ${Array.isArray(final) ? 'an array' : final === null ? 'null' : `a ${typeof final}`}.`);
            }
            if (options.schema) final = await validateWith(options.schema, final, 'The streamed object did not match the schema');
            if (id !== seq) return;
            merge(final);
            untrack(() => { state.status = 'done'; });
            options.onFinish?.(final as T);
        } catch (e) {
            if (id !== seq) return;
            current = null;
            const err = e instanceof Error ? e : new Error(String(e));
            untrack(() =>
                batch(() => {
                    state.status = 'error';
                    state.error = err;
                })
            );
            options.onError?.(err);
        }
    }

    function stop(): void {
        if (untrack(() => state.status) !== 'streaming') return;
        stopCurrent();
        untrack(() => { state.status = 'idle'; });
    }

    function reset(): void {
        stopCurrent();
        untrack(() =>
            batch(() => {
                object.$set({});
                state.status = 'idle';
                state.error = null;
                state.text = '';
            })
        );
    }

    instance.onUnmounted(() => stopCurrent());

    return {
        get object() {
            return object as Partial<T>;
        },
        get status() {
            return state.status;
        },
        get error() {
            return state.error;
        },
        get text() {
            return state.text;
        },
        run,
        stop,
        reset
    };
}

function raise(message: string): never {
    throw new Error(message);
}

/** Structural equality for JSON values — cheap enough per delta. */
function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const bb = b as unknown[];
        if (a.length !== bb.length) return false;
        for (let i = 0; i < a.length; i++) if (!sameJson(a[i], bb[i])) return false;
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    return true;
}
