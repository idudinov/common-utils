
import type {
    ILazyPromise,
    LoadingStates,
    LoadingStateStrategy,
    PendingLoadState,
    /* eslint-disable @typescript-eslint/no-unused-vars */
    IControllableLazyPromise,
} from '../../lazy/types.js';
import type { IMapModel, ValueStorageProvider } from '../../models/types.js';

export type { LoadingStates, LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
export { DEFAULT_LOADING_STATE } from '../../lazy/types.js';

/**
 * Supplies the primitives backing a promise cache's storage.
 */
export interface PromiseCacheStorageProvider extends ValueStorageProvider {
    /**
     * Creates a keyed container for per-key cache state.
     * Called during cache construction.
     * Must be identity-preserving: values read back exactly as stored, never wrapped or converted.
     */
    createMap<K, V>(): IMapModel<K, V>;
}

/** Constructor options for a promise cache. */
export interface PromiseCacheOptions<T> {
    /**
     * Supplies the storage primitives.
     * Defaults to plain `Map`/`Model`.
     */
    storage?: PromiseCacheStorageProvider;

    /** Pre-processes a value — fetched or injected via `set()` — before it is stored. */
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

/** Per-fetch-attempt scratchpad, stores arbitrary data. */
export type FetchContext = Record<string | symbol, unknown>;

/** Fields a handler can change for the handlers inward, via {@link FetchRequest.next}. */
export interface FetchOverrides<TKey extends string = string> {
    key?: TKey;
    refreshing?: boolean;
}

/** One fetch attempt's arguments. */
export interface FetchRequest<T, TKey extends string = string> {
    readonly key: TKey;

    /** `true` when the attempt was started via `refresh()`. */
    readonly refreshing: boolean;

    /** The key's state when the attempt started, before it was marked pending. */
    readonly state: PromiseCacheKeyState;

    readonly context: FetchContext;

    /**
     * Runs the next handler inward and returns its result.
     *
     * Reaches:
     * - the constructor's fetcher, when no handler is left
     * - the inner chain again, on this attempt's {@link FetchRequest.context}, when called more than once
     *
     * @param overrides Values the handlers inward see in place of this request's own, see {@link FetchOverrides}. The context and state are always carried through.
     */
    next(overrides?: FetchOverrides<TKey>): Promise<T> | T;
}

/** {@link PromiseCacheFetcher} counterpart operating on a whole {@link FetchRequest}. */
export type FetchRequestHandler<T, TKey extends string = string> = (request: FetchRequest<T, TKey>) => Promise<T> | T;

/** Base cache event payload. */
export interface PromiseCacheEvent<T, TKey extends string = string> {
    /** The cache the event originated from. */
    readonly target: IControllablePromiseCache<T, TKey, T | undefined>;
}

/** A value has been stored. */
export interface PromiseCacheStoredEvent<T, TKey extends string = string> extends PromiseCacheEvent<T, TKey> {
    readonly key: TKey;

    /** The stored (prepared) value. */
    readonly value: T;

    /** Per-key per-fetch context; `undefined` when stored via manual `set()`. */
    readonly context?: FetchContext;
}

/** A key has been removed. */
export interface PromiseCacheRemovedEvent<T, TKey extends string = string> extends PromiseCacheEvent<T, TKey> {
    readonly key: TKey;
}

/** Why a key's cached value is not valid. */
export type InvalidationReason = 'forced' | 'time' | 'check';

/** A key's state at a single moment. */
export type PromiseCacheKeyState = {
    /** {@link IPromiseCache.hasKey} */
    hasKey: boolean;

    /** {@link IPromiseCache.getHasValue} */
    hasValue: boolean;

    /** {@link IPromiseCache.getIsValid} */
    isValid: boolean;

    /** `null` when the key is not invalidated, independent of whether a value is present. */
    invalidatedBy: InvalidationReason | null;

    /** {@link IPromiseCache.getLastError} */
    error: unknown;

    /** Resolve time of the current value, `undefined` if never stamped. */
    stampedAt: number | undefined;
};

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
     * The loading state of an item; see {@link LoadingStates}.
     * Does not trigger a fetch.
     */
    getIsLoading(key: TKey): LoadingStates;

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
     * Returns an {@link ILazyPromise} handle for a specified cache key.
     *
     * @param strategy Optional per-handle `isLoading` override, see {@link LoadingStateStrategy}.
     */
    getLazy(key: TKey, strategy?: LoadingStateStrategy): ILazyPromise<T, TInitial>;

    /** Returns an iterator over the keys of the cached items. */
    keys(iterate: true): MapIterator<TKey>;

    /** Returns an array of the keys of the cached items. */
    keys(): TKey[];

    /**
     * Returns a promise that resolves to the cached value of the item if loaded already, otherwise starts fetching and the promise will be resolved to the final value.
     *
     * Concurrent calls for the same key share the same promise until it resolves.
     */
    get(key: TKey): Promise<T | TInitial>;

    /**
     * Re-fetches the value for the specified key while keeping the stale cached value available.
     *
     * Implements stale-while-revalidate semantics:
     * - the current cached value remains accessible via `getCurrent()` / `getLazy().value` during the refresh
     * - on success, the cached value is updated
     * - on error, the stale value is preserved and the error is stored
     * - multiple concurrent refreshes use "latest wins" semantics
     */
    refresh(key: TKey): Promise<T | TInitial>;
}

/**
 * {@link IPromiseCache} plus direct cache manipulation, mirroring
 * {@link IControllableLazyPromise} at the collection level.
 */
export interface IControllablePromiseCache<T, TKey = string, TInitial extends T | undefined = undefined>
    extends IPromiseCache<T, TKey, TInitial> {
    /**
     * Injects a value into the cache for the specified key, as if it had been fetched.
     * Clears any previous error and cancels any in-flight fetch for this key.
     */
    set(key: TKey, value: T): void;

    /** Marks the key's cached value stale without removing it. */
    expire(key: TKey): void;

    /**
     * Removes all per-key state for the specified key.
     *
     * @returns Whether any state existed for the key.
     */
    delete(key: TKey): boolean;

    /** Clears the cache and resets the loading state. */
    clear(): void;
}
