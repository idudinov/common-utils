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
 * `'forever'` keeps it until delete/clear/dispose, `{ ttlMs }` keeps it for `ttlMs` since the
 * last emission, then unsubscribes and deletes the key.
 */
export type SubscriptionPolicy = 'off' | 'forever' | { ttlMs: number };

export interface SubscriptionExtensionOptions<T, TKey extends string = string> {
    /** Defaults to `'forever'`. A function is resolved once per `fetch()` call, for that key. */
    policy?: SubscriptionPolicy | ((key: TKey) => SubscriptionPolicy);

    /** Merges an update emission into the current value, instead of replacing it wholesale. */
    merge?: (current: T, incoming: T) => T;
}

export const SHORT_SUBSCRIPTION_TTL_MS = 5 * 60 * 1000;

export interface ISubscriptionExtension<T, TKey extends string = string> extends IPromiseCacheExtension<T, TKey> {
    /** The adapted fetcher, to construct the cache with instead of a placeholder. */
    readonly fetch: PromiseCacheFetcher<T, TKey>;

    /** Number of keys with a live subscription. */
    readonly observedCount: number;
}

interface Entry<T> {
    policy: SubscriptionPolicy;
    unsub: DisposeFunction | null;
    timer: ReturnType<typeof setTimeout> | null;
    cancelled: boolean;
    /** Teardown was requested before `unsub` arrived; it self-disposes on arrival. */
    stopRequested: boolean;
    /** Rejects the pending fetch promise so a teardown before the first emission settles its awaiters; no-op once resolved. */
    cancelFetch: (() => void) | null;
    /** Flips true on any store for this key — the entry's own fetch result or an unrelated `set()` — gating the update path below. */
    stored: boolean;
    /** Updates that arrived before the store, or while a drain of this buffer is scheduled; applied in order via `queueMicrotask`. */
    buffer: T[];
    /** A microtask drain of `buffer` is scheduled and hasn't run yet — new updates must still queue behind it, not jump ahead. */
    drainScheduled: boolean;
}

/**
 * Adapts a live {@link SubscriptionSource} into a {@link PromiseCache} extension: the first emission
 * resolves the fetch, later ones update the cached value, and the extension solely owns each key's
 * subscription.
 *
 * Replaces the cache's fetcher instead of wrapping it, and holds that cache's subscription state —
 * create one instance per cache, and apply it via `extend()` before the first fetch.
 */
export function createSubscriptionExtension<T, TKey extends string = string>(
    subscribe: SubscriptionSource<T, TKey>,
    options?: SubscriptionExtensionOptions<T, TKey>,
): ISubscriptionExtension<T, TKey> {
    const resolvePolicy = options?.policy ?? 'forever';
    const merge = options?.merge;

    const entries = new Map<TKey, Entry<T>>();

    let target: IControllablePromiseCache<T, TKey, T | undefined> | null = null;

    /** Merges (if configured) or replaces the cached value for a live update emission. */
    const applyUpdate = (key: TKey, value: T) => {
        const cache = target;
        if (!cache) {
            return;
        }
        const current = merge ? cache.getCurrent(key, false) : undefined;
        cache.set(key, current !== undefined ? merge!(current, value) : value);
    };

    const stopEntry = (key: TKey, entry: Entry<T>) => {
        if (entries.get(key) === entry) {
            entries.delete(key);
        }

        if (entry.timer != null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }

        entry.cancelled = true;
        entry.buffer = [];
        entry.cancelFetch?.();

        if (entry.unsub) {
            const unsub = entry.unsub;
            entry.unsub = null;
            unsub();
        } else {
            entry.stopRequested = true;
        }
    };

    /**
     * Schedules a single microtask drain of `entry.buffer`, in causal order, guarded against a
     * torn-down or superseded entry. Stays `drainScheduled` for the whole drain, including while an
     * emission arrives re-entrantly (e.g. from an `onStored` observer applyUpdate's `cache.set()`
     * synchronously triggers) — that emission then queues onto the live buffer instead of jumping
     * ahead of the remainder still waiting to drain.
     */
    const scheduleDrain = (key: TKey, entry: Entry<T>) => {
        entry.drainScheduled = true;
        queueMicrotask(() => {
            while (entries.get(key) === entry && entry.buffer.length > 0) {
                const value = entry.buffer.shift()!;
                applyUpdate(key, value);
            }
            entry.drainScheduled = false;
        });
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

        const policy = typeof resolvePolicy === 'function' ? resolvePolicy(key) : resolvePolicy;
        const entry: Entry<T> = { policy, unsub: null, timer: null, cancelled: false, stopRequested: false, cancelFetch: null, stored: false, buffer: [], drainScheduled: false };
        entries.set(key, entry);

        return new Promise<T>((resolve, reject) => {
            let settled = false;

            // A teardown before the first emission must still settle awaiters — resolve to the
            // cache's current value via cache.ts's own cancelled-fetch handling, not hang forever.
            entry.cancelFetch = () => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(new Error('Subscription torn down before the first emission'));
            };

            const armTtl = () => {
                if (typeof entry.policy !== 'object') {
                    return;
                }
                if (entry.timer != null) {
                    clearTimeout(entry.timer);
                }
                entry.timer = setTimeout(() => {
                    entry.timer = null;
                    stopEntry(key, entry);
                    cache.delete(key);
                }, entry.policy.ttlMs);
            };

            const emit = (value: T) => {
                if (entry.cancelled) {
                    return;
                }

                if (!settled) {
                    settled = true;
                    armTtl();
                    resolve(value);

                    if (entry.policy === 'off') {
                        if (entry.unsub) {
                            stopEntry(key, entry);
                        } else {
                            entry.cancelled = true;
                            entry.stopRequested = true;
                        }
                    }
                    return;
                }

                // A torn-down entry must never write to the cache, even if it wins the race to settle.
                if (entries.get(key) !== entry) {
                    return;
                }

                armTtl();

                // Buffer instead of applying directly while the store hasn't happened yet (onStored
                // pending — merging now would read a not-yet-current value), or while a scheduled
                // drain of earlier buffered updates hasn't run — never jump ahead of it.
                if (!entry.stored || entry.drainScheduled) {
                    entry.buffer.push(value);
                    return;
                }

                applyUpdate(key, value);
            };

            let sourceResult: DisposeFunction | Promise<DisposeFunction>;
            try {
                sourceResult = subscribe(key, emit);
            } catch (err) {
                settled = true;
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
                        settled = true;
                        stopEntry(key, entry);
                        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the source's original error
                        reject(err);
                    } else if (entries.get(key) === entry) {
                        // The subscription died with no replacement in flight — delete so the
                        // key doesn't keep serving a value with no live source behind it.
                        stopEntry(key, entry);
                        cache.delete(key);
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
        onStored: key => {
            const entry = entries.get(key);
            if (!entry) {
                return;
            }

            entry.stored = true;

            if (entry.buffer.length === 0 || entry.drainScheduled) {
                return;
            }

            scheduleDrain(key, entry);
        },
        onRemoved: key => teardown(key),
        onCleared: () => teardownAll(),
        dispose: () => teardownAll(),
    };
}
