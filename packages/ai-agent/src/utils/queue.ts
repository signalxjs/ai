/**
 * An async push/pull queue — the buffer between a producer that must never
 * block (a turn emitting events) and a consumer that pulls at its own pace.
 * Unbounded by default; `maxSize` turns overflow into a failure the consumer
 * sees, instead of silently dropping items or stalling the producer.
 */

export interface AsyncQueue<T> extends AsyncIterable<T> {
    /** Enqueue; `false` when the queue has ended or failed (the item is dropped). */
    push(value: T): boolean;
    /** No more items after those already buffered — consumers drain, then complete. */
    end(): void;
    /** Consumers receive `error` on their next pull; buffered items are dropped. */
    fail(error: unknown): void;
    /** Items buffered and not yet pulled. */
    readonly size: number;
    /** `end()` or `fail()` was called. */
    readonly ended: boolean;
}

export interface QueueOptions {
    /** Buffered items above this count fail the queue with a `RangeError`. */
    readonly maxSize?: number;
    /** Called once when the consumer stops early (`return()`) or the queue ends. */
    readonly onClose?: () => void;
}

export function createQueue<T>(options: QueueOptions = {}): AsyncQueue<T> {
    const items: T[] = [];
    const waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
    let ended = false;
    let failure: { error: unknown } | undefined;
    let closedNotified = false;

    const notifyClose = () => {
        if (closedNotified) return;
        closedNotified = true;
        options.onClose?.();
    };

    const queue: AsyncQueue<T> = {
        get size() {
            return items.length;
        },
        get ended() {
            return ended;
        },
        push(value) {
            if (ended) return false;
            const waiter = waiting.shift();
            if (waiter) {
                waiter.resolve({ value, done: false });
                return true;
            }
            items.push(value);
            if (options.maxSize !== undefined && items.length > options.maxSize) {
                queue.fail(new RangeError(`[sigx ai-agent] queue overflow: more than ${options.maxSize} buffered items`));
                return false;
            }
            return true;
        },
        end() {
            if (ended) return;
            ended = true;
            for (const w of waiting.splice(0)) w.resolve({ value: undefined as never, done: true });
            if (!items.length) notifyClose();
        },
        fail(error) {
            if (ended) return;
            ended = true;
            failure = { error };
            items.length = 0;
            for (const w of waiting.splice(0)) w.reject(error);
            notifyClose();
        },
        [Symbol.asyncIterator]() {
            return {
                next: (): Promise<IteratorResult<T>> => {
                    if (items.length) {
                        const value = items.shift() as T;
                        if (ended && !items.length && !failure) notifyClose();
                        return Promise.resolve({ value, done: false });
                    }
                    if (failure) return Promise.reject(failure.error);
                    if (ended) return Promise.resolve({ value: undefined as never, done: true });
                    return new Promise((resolve, reject) => {
                        waiting.push({ resolve, reject });
                    });
                },
                return: (): Promise<IteratorResult<T>> => {
                    // The consumer stopped early: drop what is buffered, stop accepting.
                    ended = true;
                    items.length = 0;
                    for (const w of waiting.splice(0)) w.resolve({ value: undefined as never, done: true });
                    notifyClose();
                    return Promise.resolve({ value: undefined as never, done: true });
                },
                [Symbol.asyncIterator]() {
                    return this;
                }
            };
        }
    };
    return queue;
}
