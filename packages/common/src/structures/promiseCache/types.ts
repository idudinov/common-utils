
import type { ILazyPromise, LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
import type { IMapModel, ValueStorageProvider } from '../../models/types.js';

export type { LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
export { DEFAULT_LOADING_STATE } from '../../lazy/types.js';

/**
 * Supplies the observable primitives backing a {@link PromiseCache}'s internal storage.
 */
export interface PromiseCacheStorageProvider extends ValueStorageProvider {
    /**
     * Creates a keyed container for per-key cache state. Called during cache construction.
     * Must be identity-preserving: values read back exactly as stored, never wrapped or converted.
     */
    createMap<K, V>(): IMapModel<K, V>;
}

/** Constructor options for {@link PromiseCache}. */
export interface PromiseCacheOptions<T> {
    /** Supplies the observable storage primitives. Defaults to plain `Map`/`Model`. */
    storage?: PromiseCacheStorageProvider;

    /**
     * Pre-processes a value — fetched or injected via `set()` — before it is stored.
     *
     * Useful for wrapping the value in an observable, e.g. `observable.object`.
     */
    prepareValue?: (value: T) => T;
}

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
export type ErrorCallback<TKey> = (key: TKey, error: unknown) => void;

/**
 * Fetcher function signature for PromiseCache.
 *
 * @param key The key of the item to fetch.
 * @param refreshing `true` when called via `refresh()`, `false` on initial `get()`.
 */
export type PromiseCacheFetcher<T, TKey> = (key: TKey, refreshing?: boolean) => Promise<T>;

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
}

/**
 * Consumer-facing contract for a keyed async cache, mirroring {@link ILazyPromise} at the collection level.
 *
 * Reading via `get`/`getLazy`/`getCurrent` may trigger a fetch; every other member is passive.
 */
export interface IPromiseCache<T, TKey = string, TInitial extends T | undefined = undefined> {
    /** Returns the current cached value, optionally triggering a fetch. Falls back to the initial value if configured. */
    getCurrent(key: TKey, initiateFetch?: boolean): T | TInitial;

    /**
     * Returns the loading state of an item.
     *
     * Derived at read time from the pending kind per the configured loading-state strategy, so a strategy
     * change applies to fetches already in flight.
     *
     * @returns Strategy-derived value while a fetch is in flight; `false` once settled;
     * `null` if never started, or after an explicit `delete()`.
     */
    getIsLoading(key: TKey): boolean | null;

    /** Returns the current pending kind for the key, or `null` if idle/settled. */
    getPendingState(key: TKey): PendingLoadState | null;

    /**
     * Returns whether the key holds a resolved, error-free value.
     * A stale (expired/invalidated) value still counts; an in-flight fetch or a stored error does not.
     */
    getHasValue(key: TKey): boolean;

    /** Returns the last error that occurred during fetching for the specified key, or `null` if none. */
    getLastError(key: TKey): unknown;

    /** Returns whether the cached item for the specified key is valid (not expired and not invalidated by callback). */
    getIsValid(key: TKey): boolean;

    /** Returns true if the item is cached or fetching was initiated. Does not initiate fetching. */
    hasKey(key: TKey): boolean;

    /** Returns the number of cached items (resolved values). */
    readonly cachedCount: number;

    /**
     * Returns an {@link ILazyPromise} handle for a specified cache key, usable anywhere a
     * standalone `LazyPromise` is.
     *
     * @param strategy Optional per-handle `isLoading` override; unnamed pending states fall through
     * to the cache-level report, not to the defaults.
     */
    getLazy(key: TKey, strategy?: LoadingStateStrategy): ILazyPromise<T, TInitial>;

    /** Returns an iterator over the keys of the cached items. */
    keys(iterate: true): MapIterator<TKey>;

    /** Returns an array of the keys of the cached items. */
    keys(): TKey[];

    /**
     * Returns a promise that resolves to the cached value of the item if loaded already, otherwise
     * starts fetching and the promise will be resolved to the final value.
     *
     * Concurrent calls for the same key share the same promise until it resolves.
     */
    get(key: TKey): Promise<T | TInitial>;

    /**
     * Re-fetches the value for the specified key while keeping the stale cached value available.
     *
     * Implements stale-while-revalidate semantics:
     * - The current cached value remains accessible via `getCurrent()` / `getLazy().value` during the refresh.
     * - On success, the cached value is updated.
     * - On error, the stale value is preserved and the error is stored.
     * - Multiple concurrent refreshes use "latest wins" semantics.
     */
    refresh(key: TKey): Promise<T | TInitial>;
}

/**
 * {@link IPromiseCache} plus direct cache manipulation, mirroring {@link IControllableLazyPromise} at the
 * collection level.
 */
export interface IControllablePromiseCache<T, TKey = string, TInitial extends T | undefined = undefined>
    extends IPromiseCache<T, TKey, TInitial> {
    /** Injects a value into the cache for the specified key, as if it had been fetched. Sets the timestamp and clears any previous error. Cancels any in-flight fetch for this key. */
    set(key: TKey, value: T): void;

    /**
     * Removes all per-key state (item, promise, status, error, timestamp) for the specified key;
     * the next read refetches.
     *
     * @returns Whether any state existed for the key.
     */
    delete(key: TKey): boolean;

    /** @deprecated Use {@link delete}. */
    invalidate(key: TKey): void;

    /** Clears the cache and resets the loading state. */
    clear(): void;
}
