import { deriveIsLoading, viewLoadingState } from '../../lazy/loadingState.js';
import type { ILazyPromise, IResolvedLazyPromise, LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
import { Loggable } from '../../logger/loggable.js';
import { Model } from '../../models/Model.js';
import type { IMapModel, IValueModel } from '../../models/types.js';

/**
 * Core base class for PromiseCache. Provides basic cache operations, hooks, and `pure_create*` methods.
 *
 * This class handles:
 *  - item storage and retrieval
 *  - loading state tracking
 *  - promise caching
 *  - error storage
 *  - timestamps for cached items
 *  - direct cache manipulation (invalidate, set, clear)
 *  - keys iteration
 *
 * Subclasses are expected to implement fetching logic, invalidation policies, etc.
 */
export abstract class PromiseCacheCore<T, K = string, TInitial extends T | undefined = undefined> extends Loggable {

    /** Stores resolved items in map by id. */
    protected readonly _itemsCache: IMapModel<string, T>;

    /** Stores items loading state in map by id: pending kind while in flight, `false` once settled, absent if never started. */
    protected readonly _itemsStatus: IMapModel<string, false | PendingLoadState>;

    /** Stores items loading count. */
    protected readonly _loadingCount: IValueModel<number>;

    /** Stores items Promises state (if still loading) in map by id. */
    protected readonly _fetchCache: IMapModel<string, Promise<T | TInitial>>;

    /** Stores last errors by key. Observable-friendly via IMapModel. */
    protected readonly _errorsMap: IMapModel<string, unknown>;

    /** Stores items resolve timestamps (for expiration) in map by id. */
    protected readonly _timestamps = new Map<string, number>();

    /**
     * Tracks the latest in-flight factory promise per key for "latest wins" refresh semantics.
     * Separate from `_fetchCache` (which stores the public-facing promise returned to callers).
     */
    protected readonly _activeFetchPromises = new Map<string, Promise<T | TInitial>>();

    protected _version = 0;

    private _loadingStrategy: LoadingStateStrategy | undefined;

    constructor(
        protected readonly keyAdapter?: ((k: K) => string) | null,
        protected readonly keyParser?: ((id: string) => K) | null,
    ) {
        super();

        this._loadingCount = this.pure_createLoadingCount();
        this._itemsCache = this.pure_createMap<string, T>();
        this._itemsStatus = this.pure_createMap<string, false | PendingLoadState>();
        this._fetchCache = this.pure_createMap<string, Promise<T | TInitial>>();
        this._errorsMap = this.pure_createMap<string, unknown>();
    }

    /**
     * Configures the per-pending-state `isLoading` override; missing keys fall back to {@link DEFAULT_LOADING_STATE}.
     * Applies to every key. The strategy is stored as-is (not copied), so getter-based fields are
     * re-evaluated on each read. Subsequent calls replace the previous strategy, not merge with it.
     */
    useLoadingState(strategy: LoadingStateStrategy): this {
        this._loadingStrategy = strategy;
        return this;
    }

    // ─── Counts ──────────────────────────────────────────────────────────

    /**
     * Returns the number of items currently being fetched, including background refreshes.
     *
     * Unlike `getIsLoading(key)` (which reports per {@link LoadingStateStrategy} and can be
     * silenced for some pending kinds), this count always increments for every in-flight fetch —
     * use it for a global "something is loading" indicator.
     */
    public get loadingCount(): number { return this._loadingCount.value; }

    /** Returns the number of cached items (resolved values). */
    public get cachedCount(): number { return this._itemsCache.size; }

    /** Returns the number of in-flight promises (items currently being fetched). */
    public get promisesCount(): number { return this._fetchCache.size; }

    /** Returns the number of cached items that are currently invalid (expired). */
    public get invalidCount(): number {
        let count = 0;
        for (const key of this._itemsCache.keys()) {
            if (this.getIsInvalidated(key)) {
                count++;
            }
        }
        return count;
    }

    // ─── Pure factory methods ──────────────────────────────────────────────

    /**
     * @pure @const
     * Creates a model for tracking the loading state.
     *
     * Warning: as name indicates, this should be "pure"/"const" function, i.e. should not reference `this`/`super`.
     */
    protected pure_createLoadingCount(): IValueModel<number> {
        return new Model(0);
    }

    /**
     * @pure @const
     * Creates the map implementation used for all internal keyed storage.
     * Must be a plain, identity-preserving map: values read back are exactly the values stored,
     * never wrapped or converted. Value preparation has a dedicated hook: {@link prepareResult}.
     * Must not reference instance state — called during construction.
     */
    protected pure_createMap<TK, TV>(): IMapModel<TK, TV> {
        return new Map<TK, TV>();
    }

    // ─── Key handling ────────────────────────────────────────────────────

    protected _pk(k: K): string {
        if (k == null) {
            throw new Error('PromiseCache: null keys are not supported');
        }

        if (typeof k === 'string') {
            return k;
        }

        if (!this.keyAdapter) {
            throw new Error('Provide key adapter for non-string keys');
        }

        return this.keyAdapter(k);
    }

    protected getLoggerName(name: string | undefined): string {
        return `[PromiseCache:${name || '?'}]`;
    }

    // ─── Public API: reading ─────────────────────────────────────────────

    /**
     * Returns an {@link ILazyPromise} handle for a specified cache key.
     *
     * The returned object implements the same interface as a standalone `LazyPromise`,
     * allowing consumers to use a single `ILazyPromise<T>` interface regardless of whether
     * the data comes from a single lazy value or a keyed cache.
     *
     * - `value` / `promise` trigger a fetch if not started.
     * - `currentValue` reads without triggering.
     * - `refresh()` re-fetches while keeping the stale value available.
     *
     * @param strategy Optional per-handle `isLoading` override; unnamed pending states fall through
     * to the cache-level report, not to the defaults.
     */
    getLazy(key: K, strategy?: LoadingStateStrategy): ILazyPromise<T, TInitial> {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const k = self._pk(key);
        const handle: ILazyPromise<T, TInitial> = {
            get value() { return self._getCurrentByKey(k, key, true); },
            get currentValue() { return self._getCurrentByKey(k, key, false); },
            get hasValue() {
                return self._itemsCache.has(k) && !self._errorsMap.has(k);
            },
            get error() { return self._getLastErrorByKey(k); },
            get isLoading() {
                return self._getIsLoadingByKey(k);
            },
            get pendingState(): PendingLoadState | null {
                return self._itemsStatus.get(k) || null;
            },
            get promise() { return self.get(key); },
            refresh() {
                return self.refresh(key);
            },
            hasResolvedValue(this: ILazyPromise<T, TInitial>): this is IResolvedLazyPromise<T, TInitial> {
                return handle.hasValue;
            },
        };
        return strategy ? viewLoadingState(handle, strategy) : handle;
    }

    /**
     * Returns the loading state of an item.
     *
     * Derived at read time from the pending kind per {@link useLoadingState}, so a strategy change
     * applies to fetches already in flight.
     *
     * @returns Strategy-derived value while a fetch is in flight; `false` once settled and valid;
     * `null` if never started, or after an explicit `invalidate()`.
     */
    getIsLoading(id: K): boolean | null {
        return this._getIsLoadingByKey(this._pk(id));
    }

    private _getIsLoadingByKey(key: string): boolean | null {
        const res = this._itemsStatus.get(key);
        if (res) {
            return deriveIsLoading(res, this._loadingStrategy);
        }
        return res ?? null;
    }

    /**
     * Returns whether the cached item for the specified key is valid (not expired and not invalidated by callback).
     *
     * @returns `true` if the item is cached and valid, `false` if the item is invalidated or not cached.
     */
    getIsValid(id: K): boolean {
        const key = this._pk(id);
        return this._itemsCache.has(key) && !this.getIsInvalidated(key);
    }

    /**
     * Returns the last error that occurred during fetching for the specified key.
     *
     * @returns The raw error, or null if no error.
     */
    getLastError(id: K): unknown {
        return this._getLastErrorByKey(this._pk(id));
    }

    private _getLastErrorByKey(key: string): unknown {
        return this._errorsMap.get(key) ?? null;
    }

    /** Returns the current cached value, optionally triggering a fetch. Falls back to the initial value if configured. */
    getCurrent(id: K, initiateFetch = true): T | TInitial {
        return this._getCurrentByKey(this._pk(id), id, initiateFetch);
    }

    private _getCurrentByKey(key: string, id: K, initiateFetch: boolean): T | TInitial {
        if (initiateFetch) {
            this.get(id);
        }
        const result = this._getCachedOrInitial(key, id);
        this.logger.log(key, 'getCurrent: returns', result);
        return result;
    }

    /** Returns a promise that resolves to the cached or freshly fetched value. */
    abstract get(id: K): Promise<T | TInitial>;

    /**
     * Re-fetches the value for the specified key while keeping the stale cached value available.
     *
     * Implements stale-while-revalidate semantics:
     * - The current cached value remains accessible via `getCurrent()` / `getLazy().value` during the refresh.
     * - On success, the cached value is updated.
     * - On error, the stale value is preserved and the error is stored.
     * - Multiple concurrent refreshes use "latest wins" semantics.
     *
     * @param id The key of the item to refresh.
     * @returns A promise resolving to the refreshed value, or the stale value on error.
     */
    abstract refresh(id: K): Promise<T | TInitial>;

    /** Returns true if the item is cached or fetching was initiated. Does not initiate fetching. */
    hasKey(id: K) {
        const key = this._pk(id);
        return this._itemsCache.has(key) || this._itemsStatus.has(key);
    }

    /** Returns an iterator over the keys of the cached items. */
    keys(iterate: true): MapIterator<string>;

    /** Returns an array of the keys of the cached items. */
    keys(): string[];

    keys(iterate: boolean = false) {
        const iterator = this._itemsCache.keys();
        return iterate
            ? iterator
            : Array.from(iterator);
    }

    /** Returns an iterator over the parsed keys of the cached items. */
    keysParsed(iterate: true): Generator<K> | null;

    /** Returns an array of the parsed keys of the cached items. */
    keysParsed(): K[] | null;

    keysParsed(iterate: boolean = false) {
        const kp = this.keyParser;
        if (!kp) {
            return null;
        }

        const keysIterator = this.keys(true);
        if (!iterate) {
            return Array.from(keysIterator, key => kp(key));
        }

        return (function* () {
            for (const key of keysIterator) {
                yield kp(key);
            }
        })();
    }

    // ─── Public API: mutation ────────────────────────────────────────────

    /** Instantly invalidates the cached item for the specified id, like it was never fetched/accessed. */
    invalidate(id: K) {
        const key = this._pk(id);
        this._deleteKey(key);
        this._errorsMap.delete(key);
        this._timestamps.delete(key);
        this._activeFetchPromises.delete(key);
    }

    /** Injects a value into the cache for the specified key, as if it had been fetched. Sets the timestamp and clears any previous error. Cancels any in-flight fetch for this key. */
    set(id: K, value: T) {
        const key = this._pk(id);
        this._fetchCache.delete(key);
        this.setStatus(key, false);
        this._itemsCache.set(key, value);
        this._timestamps.set(key, Date.now());
        this._errorsMap.delete(key);
        this._activeFetchPromises.delete(key);
    }

    /**
     * @deprecated Use {@link set} instead.
     */
    updateValueDirectly(id: K, value: T) {
        return this.set(id, value);
    }

    /**
     * Iterates over all cached items and removes those that are invalid (expired).
     *
     * @returns The number of items that were removed.
     */
    sanitize(): number {
        let removed = 0;
        const keysToRemove: string[] = [];

        for (const key of this._itemsCache.keys()) {
            if (this.getIsInvalidated(key)) {
                keysToRemove.push(key);
            }
        }

        for (const key of keysToRemove) {
            this._deleteKey(key);
            this._errorsMap.delete(key);
            this._timestamps.delete(key);
            this._activeFetchPromises.delete(key);
            removed++;
        }

        return removed;
    }

    /** Clears the cache and resets the loading state. */
    clear() {
        ++this._version;
        this._loadingCount.value = 0;

        this._itemsCache.clear();
        this._itemsStatus.clear();
        this._fetchCache.clear();
        this._errorsMap.clear();
        this._timestamps.clear();
        this._activeFetchPromises.clear();
    }

    // ─── Protected hooks ─────────────────────────────────────────────────


    /** Returns the cached value if present, otherwise the initial value for the key. */
    protected _getCachedOrInitial(key: string, id: K): T | TInitial {
        return this._itemsCache.has(key) ? this._itemsCache.get(key)! : this._getInitialValue(id);
    }

    /**
     * Checks if the cached item for the specified key is invalidated (expired).
     * Override to implement custom invalidation logic.
     */
    protected abstract getIsInvalidated(key: string): boolean;

    /** Returns the initial/default value for a key. Used as fallback when no cached value exists. */
    protected abstract _getInitialValue(id: K): TInitial;

    /** @internal Deletes all cache entries for a key (item, promise, status). */
    protected _deleteKey(key: string) {
        this._fetchCache.delete(key);
        this._itemsStatus.delete(key);
        this._itemsCache.delete(key);
    }

    /** Updates the loading status for the specified key. Override to add a hook. */
    protected setStatus(key: string, status: false | PendingLoadState) {
        this.logger.log(key, 'status update:', status);
        this._itemsStatus.set(key, status);
    }

    /** Updates the promise for the specified key. Override to add a hook. */
    protected setPromise(key: string, promise: Promise<T | TInitial>) {
        this._fetchCache.set(key, promise);
    }

    /** Stores the result for the specified key. Override to add a hook. */
    protected storeResult(key: string, res: T) {
        this._itemsCache.set(key, res);
        this._timestamps.set(key, Date.now());
        this._errorsMap.delete(key);
    }

    /** Hooks into the fetch process before it starts. */
    protected onBeforeFetch(_key: string) {
        this._loadingCount.value = this._loadingCount.value + 1;
    }

    /** Hooks into the fetch process after it completes. */
    protected onFetchComplete(key: string) {
        this._loadingCount.value = this._loadingCount.value - 1;
        this._fetchCache.delete(key);
        this.setStatus(key, false);
    }

    /** Hooks into the superseded fetch cleanup. Only decrements loading count — does not touch fetch cache or status. */
    protected onFetchSuperseded(_key: string) {
        this._loadingCount.value = this._loadingCount.value - 1;
    }

    /** Hooks into cancelled fetch cleanup (set()/invalidate() called mid-flight). Decrements loading count and cleans fetch cache. Restores _itemsStatus for set() path; clears all per-key bookkeeping for invalidate() path. */
    protected onFetchCancelled(key: string) {
        this._loadingCount.value = this._loadingCount.value - 1;
        this._fetchCache.delete(key);
        if (this._itemsCache.has(key)) {
            this._itemsStatus.set(key, false);
        } else {
            // invalidate() path — ensure no stale bookkeeping remains
            this._itemsStatus.delete(key);
            this._timestamps.delete(key);
            this._errorsMap.delete(key);
        }
    }

    /** Hooks into the result preparation process, before it's stored into the cache. */
    protected prepareResult(res: T) {
        return res;
    }

}
