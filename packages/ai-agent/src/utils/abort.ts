/**
 * Abort plumbing — every cancellation becomes one `AbortError`.
 *
 * A copy of `packages/ai/src/engine/abort.ts`, which is private to the core's
 * engine folder (not re-exported). The two stay in step by hand; the agent
 * layer must not reach into another package's private files.
 */

/** Settle with `promise`, or reject the moment `signal` aborts — whichever comes first. */
export function abortable<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (v) => {
                signal.removeEventListener('abort', onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener('abort', onAbort);
                reject(e);
            }
        );
    });
}

/**
 * Every abort becomes an `AbortError` — whatever the caller passed as the
 * reason — so cancellation always takes the cancellation path rather than
 * being mistaken for a failure. The original reason is kept as `cause`.
 */
export function abortError(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    if (reason instanceof Error && reason.name === 'AbortError') return reason;
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'The operation was aborted';
    const err = new Error(message, reason !== undefined ? { cause: reason } : undefined);
    err.name = 'AbortError';
    return err;
}

export function isAbort(e: unknown): boolean {
    return e instanceof Error && e.name === 'AbortError';
}

/** A signal that aborts when ANY of `signals` aborts (undefined entries are skipped). */
export function anySignal(signals: ReadonlyArray<AbortSignal | undefined>): { readonly signal: AbortSignal; abort(reason?: unknown): void } {
    const controller = new AbortController();
    const forward = (s: AbortSignal) => controller.abort(s.reason);
    for (const s of signals) {
        if (!s) continue;
        if (s.aborted) {
            forward(s);
            break;
        }
        s.addEventListener('abort', () => forward(s), { once: true });
    }
    return { signal: controller.signal, abort: (reason) => controller.abort(reason) };
}

/** Resolve after `ms`, or reject with an `AbortError` if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return abortable(
        signal,
        new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        })
    );
}
