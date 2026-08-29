
export type { LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
export { DEFAULT_LOADING_STATE } from '../../lazy/types.js';

/**
 * Callback for deciding if a cached item is invalid by key, value, and cached timestamp.
 *
 * @param key The cache key (string).
 * @param value The cached value.
 * @param cachedAt The timestamp (ms) when the item was cached.
 * @returns `true` if the item should be considered invalid.
 */
export type InvalidationCallback<T> = (key: string, value: T | undefined, cachedAt: number) => boolean;

/** Callback for handling errors during fetching. */
export type ErrorCallback<K> = (key: K, error: unknown) => void;

/**
 * Fetcher function signature for PromiseCache.
 *
 * @param id The key of the item to fetch.
 * @param refreshing `true` when called via `refresh()`, `false` on initial `get()`.
 */
export type PromiseCacheFetcher<T, K = string> = (id: K, refreshing?: boolean) => Promise<T>;

/** Converts a non-string key to a string for internal cache storage. Resolves to `undefined` when `K` is `string`. */
export type PromiseCacheKeyAdapter<K> = K extends string ? undefined : (k: K) => string;

/** Parses a string key back to the original key type. Resolves to `undefined` when `K` is `string`. */
export type PromiseCacheKeyParser<K> = K extends string ? undefined : (id: string) => K;

/**
 * Configuration for cache invalidation policy.
 *
 * All fields are optional and readonly so consumers can provide dynamic data via getters.
 * The object is stored as-is (not destructured), so getter-based fields will be re-evaluated on each access.
 */
export interface InvalidationConfig<T> {
    /** Default expiration time in milliseconds for cached items. If null/undefined, time-based expiration is disabled. */
    readonly expirationMs?: number | null;

    /**
     * Optional callback that decides if an item is invalid by key, cached value, and cached timestamp.
     * Called in addition to time-based expiration.
     */
    readonly invalidationCheck?: InvalidationCallback<T> | null;

    /**
     * Maximum number of items to hold in cache. When exceeded, invalid items are cleaned up first,
     * then oldest valid items are removed to make room.
     *
     * Note: items currently being fetched (in-flight) are not evicted.
     *
     * Performance: eviction scans all cached timestamps linearly. Suitable for caches up to ~1000 items.
     */
    readonly maxItems?: number | null;

    /**
     * @deprecated This option is now ignored — stale values are always kept during invalidation (stale-while-revalidate).
     * Use `invalidate()` followed by `get()` if you need to clear the stale value before re-fetching.
     */
    readonly keepInstance?: boolean;
}
