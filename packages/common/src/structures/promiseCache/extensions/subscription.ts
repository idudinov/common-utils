import type { DisposeFunction } from '../../../functions/disposer.js';
import type { IControllablePromiseCache, PromiseCacheFetcher } from '../types.js';
import type { IPromiseCacheExtension } from './types.js';

/**
 * A live data source for one cache key: `emit` delivers values until the returned/resolved disposer
 * is called. Must emit at least once or reject/throw — one that never does leaves the fetch pending.
 */
export type SubscriptionSource<T, TKey extends string = string> =
    (key: TKey, emit: (value: T) => void) => DisposeFunction | Promise<DisposeFunction>;

/**
 * Subscription lifetime after the first emission: `'off'` unsubscribes right away (one-shot fetch),
 * `'forever'` keeps it until invalidate/clear/dispose, `{ ttlMs }` keeps it for `ttlMs` since the
 * last emission, then unsubscribes and invalidates the key.
 */
export type SubscriptionPolicy = 'off' | 'forever' | { ttlMs: number };

export const SHORT_SUBSCRIPTION_TTL_MS = 5 * 60 * 1000;

export interface ISubscriptionExtension<T, TKey extends string = string> extends IPromiseCacheExtension<T, TKey> {
    /** The adapted fetcher, to construct the cache with instead of a placeholder. */
    readonly fetch: PromiseCacheFetcher<T, TKey>;

    /** Number of keys with a live subscription. */
    readonly observedCount: number;
}

interface Entry {
    unsub: DisposeFunction | null;
    timer: ReturnType<typeof setTimeout> | null;
    cancelled: boolean;
    /** Teardown was requested before `unsub` arrived; it self-disposes on arrival. */
    stopRequested: boolean;
}

/**
 * Adapts a live {@link SubscriptionSource} into a {@link PromiseCache} extension: the first emission
 * resolves the fetch, later ones update the cached value, and the extension solely owns each key's
 * subscription.
 *
 * Replaces the cache's fetcher instead of wrapping it, and holds that cache's subscription state —
 * create one instance per cache, and apply it via `extend()` before the first fetch.
 *
 * @param policy Defaults to `'forever'`.
 */
export function createSubscriptionExtension<T, TKey extends string = string>(
    subscribe: SubscriptionSource<T, TKey>,
    policy: SubscriptionPolicy = 'forever',
): ISubscriptionExtension<T, TKey> {
    const entries = new Map<TKey, Entry>();

    let target: IControllablePromiseCache<T, TKey, T | undefined> | null = null;

    const stopEntry = (key: TKey, entry: Entry) => {
        if (entries.get(key) === entry) {
            entries.delete(key);
        }

        if (entry.timer != null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }

        entry.cancelled = true;

        if (entry.unsub) {
            const unsub = entry.unsub;
            entry.unsub = null;
            unsub();
        } else {
            entry.stopRequested = true;
        }
    };

    const teardown = (key: TKey) => {
        const entry = entries.get(key);
        if (entry) {
            stopEntry(key, entry);
        }
    };

    const teardownAll = () => {
        for (const key of Array.from(entries.keys())) {
            teardown(key);
        }
        entries.clear();
    };

    const fetch: PromiseCacheFetcher<T, TKey> = key => {
        const cache = target;
        if (!cache) {
            return Promise.reject(new Error('Subscription extension must be applied via extend() before the cache fetches'));
        }

        teardown(key);

        const entry: Entry = { unsub: null, timer: null, cancelled: false, stopRequested: false };
        entries.set(key, entry);

        return new Promise<T>((resolve, reject) => {
            let settled = false;

            const armTtl = () => {
                if (typeof policy !== 'object') {
                    return;
                }
                if (entry.timer != null) {
                    clearTimeout(entry.timer);
                }
                entry.timer = setTimeout(() => {
                    entry.timer = null;
                    stopEntry(key, entry);
                    cache.invalidate(key);
                }, policy.ttlMs);
            };

            const emit = (value: T) => {
                if (entry.cancelled) {
                    return;
                }

                if (!settled) {
                    settled = true;
                    armTtl();
                    resolve(value);

                    if (policy === 'off') {
                        if (entry.unsub) {
                            stopEntry(key, entry);
                        } else {
                            entry.cancelled = true;
                            entry.stopRequested = true;
                        }
                    }
                    return;
                }

                armTtl();
                cache.set(key, value);
            };

            let sourceResult: DisposeFunction | Promise<DisposeFunction>;
            try {
                sourceResult = subscribe(key, emit);
            } catch (err) {
                stopEntry(key, entry);
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the source's original error
                reject(err);
                return;
            }

            Promise.resolve(sourceResult).then(
                unsub => {
                    entry.unsub = unsub;
                    if (entry.stopRequested) {
                        stopEntry(key, entry);
                    }
                },
                err => {
                    if (!settled) {
                        stopEntry(key, entry);
                        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the source's original error
                        reject(err);
                    } else if (entries.get(key) === entry) {
                        stopEntry(key, entry);
                    }
                },
            );
        });
    };

    return {
        fetch,
        get observedCount() { return entries.size; },
        overrideFetcher: (_original, extended) => {
            target = extended;
            return fetch;
        },
        onInvalidated: key => teardown(key),
        onCleared: () => teardownAll(),
        dispose: () => teardownAll(),
    };
}
