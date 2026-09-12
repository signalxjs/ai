/** Abort plumbing for the tool loop — every cancellation becomes one `AbortError`. */

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
 * reason — so cancellation always takes the cancellation path (a quiet
 * `finish`) rather than being mistaken for a failure. The original reason
 * is kept as `cause`.
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
