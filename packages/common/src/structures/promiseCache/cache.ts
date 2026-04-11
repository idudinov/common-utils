import { DebounceProcessor } from '../../functions/debounce.js';
import { PromiseCacheCore } from './core.js';
import type { ErrorCallback, InvalidationConfig, PromiseCacheFetcher, PromiseCacheKeyAdapter, PromiseCacheKeyParser } from './types.js';

const BATCHING_DELAY = 200;

/**
 * Caches items by a key (string or another type) which are resolved by an async fetcher (`Promise`).
 *
 * Supports:
 *  - custom key adapter and parser for non-string keys.
 *  - direct manual cache manipulation.
 *  - batching of fetches.
 *  - auto-invalidation of cached items (time-based, callback-based, max items).
 *  - error tracking per key.
*/
export class PromiseCache<T, K = string, TInitial extends T | undefined = undefined> extends PromiseCacheCore<T, K, TInitial> {

    private _batch: DebounceProcessor<K, T[]> | null = null;
    private _invalidationConfig: InvalidationConfig<T> | null = null;
    private _onError: ErrorCallback<K> | null = null;
    private _initialValueFactory: ((key: K) => TInitial) | null = null;

    /**
     * Creates an instance of PromiseCache.
     * @param fetcher Function to fetch data by key.
     * @param keyAdapter Optional function to adapt non-string keys to strings.
     * @param keyParser Optional function to parse string keys back to their original type.
     */
    constructor(
        private readonly fetcher: PromiseCacheFetcher<T, K>,
        keyAdapter?: PromiseCacheKeyAdapter<K>,
        keyParser?: PromiseCacheKeyParser<K>,
    ) {
        super(keyAdapter, keyParser);
    }

    // ─── Configuration ───────────────────────────────────────────────────

    /**
     * Provide a fetcher function that takes multiple ids and returns multiple results at once. Will be called with a slight delay to allow multiple ids to be collected.
     *
     * Warning: resolved array should have the same order as the input array.
     *
     * When provided, effectively replaces the main fetcher; but in case of fail, fallbacks to the main fetcher.
    */
    useBatching(fetcher: (ids: K[]) => Promise<T[]>, delay = BATCHING_DELAY) {
        this._batch = fetcher ? new DebounceProcessor(fetcher, delay) : null;
        return this;
    }

    /**
     * Enables auto-invalidation of cached items by time.
     *
     * This is a convenience wrapper around {@link useInvalidation}.
     *
     * @param ms Time in milliseconds after which the item will be considered invalid. If null, auto-invalidation is disabled.
     *
     * @deprecated The `keepInstance` parameter is deprecated and ignored — stale values are now always kept during invalidation.
     * Use `invalidate()` followed by `get()` if you need to clear the stale value before re-fetching.
    */
    useInvalidationTime(ms: number | null, _keepInstance?: boolean) {
        return this.useInvalidation(ms != null ? { expirationMs: ms } : null);
    }

    /**
     * Configures advanced invalidation policy.
     *
     * The config object is stored as-is (not destructured), so getter-based fields will be re-evaluated on each access.
     * This allows consumers to provide dynamic invalidation policies.
     *
     * @param config The invalidation configuration. See {@link InvalidationConfig} for details.
     */
    useInvalidation(config: InvalidationConfig<T> | null) {
        this._invalidationConfig = config;
        return this;
    }

    /**
     * Sets an error callback that is called when a fetcher fails.
     *
     * @param callback The callback to call on error. Receives the original key and the raw error.
     */
    useOnError(callback: ErrorCallback<K> | null) {
        this._onError = callback;
        return this;
    }

    /**
     * Sets a default/initial value returned before the fetch completes or on error when no stale value exists.
     *
     * Accepts either a static value or a per-key factory function `(key: K) => TInitial`.
     * The value is **not** stored in the cache — it's a synthetic default (same as `LazyPromise`'s initial value).
     *
     * **Note:** Functions are always interpreted as factories. If `T` is a function type,
     * wrap it: `useInitialValue((key) => myFallbackFn)`.
     *
     * @param initial A value (non-function) or `(key: K) => TInitial` factory.
     * @returns `this` for chaining.
     */
    useInitialValue<TNewInitial extends T | undefined>(initial: TNewInitial | ((key: K) => TNewInitial)) {
        const self = this as unknown as PromiseCache<T, K, TNewInitial>;
        self._initialValueFactory = typeof initial === 'function'
            ? initial as (key: K) => TNewInitial
            : (_key: K) => initial;
        return self;
    }

    // ─── Core implementation ─────────────────────────────────────────────

    /**
     * Returns a promise that resolves to the cached value of the item if loaded already, otherwise starts fetching and the promise will be resolved to the final value.
     *
     * Consequent calls will return the same promise until it resolves.
     *
     * @param id The id of the item.
     * @returns A promise that resolves to the result, whether it's cached or freshly fetched.
     */
    get(id: K): Promise<T | TInitial> {
        const key = this._pk(id);

        // return cached item if it's not invalidated
        if (this._itemsCache.has(key) && !this.getIsInvalidated(key)) {
            const item = this._itemsCache.get(key)!;
            this.logger.log(key, 'get: item resolved to', item);
            return Promise.resolve(item);
        }

        // Join an existing in-flight fetch/refresh if one exists
        let promise = this._fetchCache.get(key);
        if (promise != null) {
            this.logger.log(key, 'get: item resolved to <promise>');
            return promise;
        }

        // If a fetch is in progress or already completed (with error) and not invalidated,
        // don't start a new fetch — error is "sticky". Use refresh() or invalidate() to retry.
        if (this._itemsStatus.has(key) && !this.getIsInvalidated(key)) {
            const status = this._itemsStatus.get(key);
            this.logger.log(key, 'get: fetch already', status ? 'in progress' : 'completed (error)', '— returning initial value');
            return Promise.resolve(this._getInitialValue(id));
        }

        this.setStatus(key, true);

        promise = this._doFetchAsync(id, key, false);

        this.setPromise(key, promise);

        return promise;
    }

    /**
     * Re-fetches the value for the specified key while keeping the stale cached value available.
     *
     * Does not change the loading status — consumers reading `getCurrent()` / `getLazy().value`
     * continue to see the stale value as if nothing happened.
     *
     * Implements "latest wins" concurrency: if multiple refreshes are called concurrently,
     * all promises resolve to the value from the latest refresh.
     *
     * On error, the stale value is preserved and the error is stored.
     *
     * @param id The key of the item to refresh.
     * @returns A promise resolving to the refreshed value, or the stale value on error.
     */
    refresh(id: K): Promise<T | TInitial> {
        const key = this._pk(id);

        const promise = this._doFetchAsync(id, key, true);

        this.setPromise(key, promise);

        return promise;
    }

    /** Clears the cache and resets the loading state. */
    override clear() {
        this._batch?.clear();
        super.clear();
    }

    // ─── Protected overrides ─────────────────────────────────────────────

    protected _getInitialValue(id: K): TInitial {
        return this._initialValueFactory ? this._initialValueFactory(id) : undefined as TInitial;
    }

    protected getIsInvalidated(key: string) {
        const config = this._invalidationConfig;
        if (!config) {
            return false;
        }

        const ts = this._timestamps.get(key);

        // Check time-based expiration
        const expirationMs = config.expirationMs;
        if (expirationMs != null && expirationMs > 0 && ts != null) {
            if (Date.now() - ts > expirationMs) {
                return true;
            }
        }

        // Check callback-based invalidation
        if (config.invalidationCheck && this._itemsCache.has(key)) {
            const value = this._itemsCache.get(key)!;
            if (config.invalidationCheck(key, value, ts ?? 0)) {
                return true;
            }
        }

        return false;
    }

    /** @override Stores the result for the specified key, enforcing max items. */
    protected override storeResult(key: string, res: T) {
        this._enforceMaxItems(key);
        super.storeResult(key, res);
    }

    // ─── Private ─────────────────────────────────────────────────────────

    /**
     * Unified fetch method with "latest wins" semantics.
     *
     * - Tracks the active factory promise per key via `_activeFetchPromises`.
     * - If superseded by a newer fetch, delegates to the newer promise.
     * - On error, preserves the stale cached value.
     *
     * @param id The original key.
     * @param key The string cache key.
     * @returns A promise resolving to the fetched/refreshed value, or the stale value on error.
     */
    protected async _doFetchAsync(id: K, key: string, refreshing: boolean): Promise<T | TInitial> {
        let isInSameVersion = true;
        let completionKind: 'latest' | 'superseded' | 'cancelled' | null = null;
        try {
            this.onBeforeFetch(key);
            const v = this._version;

            // Create the factory promise and mark it as the active one for this key (latest wins)
            const factoryPromise = this.tryFetchInBatch(id, refreshing);
            this._activeFetchPromises.set(key, factoryPromise);

            let fetchResult: { ok: true; value: T } | { ok: false };
            try {
                fetchResult = { ok: true, value: await factoryPromise };
            } catch (err) {
                this._handleError(id, err);
                fetchResult = { ok: false };
            }

            if (v !== this._version) {
                isInSameVersion = false;
                this._activeFetchPromises.delete(key);
                // resolve with actual result but don't store it
                return fetchResult.ok ? fetchResult.value : this._getInitialValue(id);
            }

            // Check if this is still the active (latest) fetch for this key
            const currentActive = this._activeFetchPromises.get(key);

            if (currentActive === factoryPromise) {
                completionKind = 'latest';
            } else if (currentActive != null) {
                // Superseded by a newer refresh/fetch — delegate to the latest promise
                completionKind = 'superseded';
                const newerPromise = this._fetchCache.get(key);
                if (newerPromise) {
                    return newerPromise.catch(() => this._getCachedOrInitial(key, id));
                }
                return this._getCachedOrInitial(key, id);
            } else {
                // Active promise removed by set()/invalidate() — clean up
                // in-flight bookkeeping without restoring _itemsStatus.
                completionKind = 'cancelled';
                return this._getCachedOrInitial(key, id);
            }

            // We are the latest — clean up tracking
            this._activeFetchPromises.delete(key);

            if (fetchResult.ok) {
                const res = this.prepareResult(fetchResult.value);
                this.logger.log(key, 'item\'s <promise> resolved to', res);
                this.storeResult(key, res);
                return res;
            }

            // Fetch failed — record timestamp for time-based invalidation expiry,
            // and return stale value or initial.
            this._timestamps.set(key, Date.now());
            return this._getCachedOrInitial(key, id);
        } finally {
            if (!isInSameVersion) {
                this.logger.log(key, 'skipping item\'s resolve due to version change ("clear()" has been called)');
            } else if (completionKind === 'latest') {
                this.onFetchComplete(key);
            } else if (completionKind === 'cancelled') {
                this.onFetchCancelled(key);
            } else {
                this.onFetchSuperseded(key);
            }
        }
    }

    /** Performs a fetch operation in batch mode if available, otherwise uses the regular fetch. Throws on error. */
    protected async tryFetchInBatch(id: K, refreshing?: boolean): Promise<T> {
        if (!this._batch) {
            return this.fetcher(id, refreshing);
        }

        const res = await this._batch.push(id)
            .catch(err => {
                this.logger.warn('batch fetch failed', id, err);
                return null;
            });
        if (!res || !res.result || res.result[res.index] === undefined) {
            // batch call failed or returned no result — fallback to the direct fetcher
            return this.fetcher(id, refreshing);
        }

        return res.result[res.index];
    }

    /** Handles a fetch error: stores it, logs it, and calls the onError callback. */
    protected _handleError(id: K, err: unknown) {
        const key = this._pk(id);
        this._errorsMap.set(key, err);
        this.logger.warn('fetcher failed', id, err);

        if (this._onError) {
            try {
                this._onError(id, err);
            } catch {
                // ignore errors in the callback
            }
        }
    }

    /**
     * Enforces the max items limit by removing items to make room.
     * Strategy: first removes invalid items, then oldest valid items by timestamp.
     * Items currently being fetched (in-flight) are not evicted.
     *
     * Note: Phase 2 scans all timestamps linearly (O(n) per eviction).
     * This is acceptable for typical `maxItems` values (up to ~1000).
     *
     * @param incomingKey The key of the item about to be stored (excluded from eviction).
     */
    private _enforceMaxItems(incomingKey: string) {
        const maxItems = this._invalidationConfig?.maxItems;
        if (maxItems == null || maxItems <= 0) {
            return;
        }

        // If we're under the limit, nothing to do
        if (this._itemsCache.size < maxItems) {
            return;
        }

        // Phase 1: Remove invalid items first (they're garbage anyway)
        const invalidKeys: string[] = [];
        for (const key of this._itemsCache.keys()) {
            if (key === incomingKey) continue;
            if (this.getIsInvalidated(key)) {
                invalidKeys.push(key);
            }
        }

        for (const key of invalidKeys) {
            this._deleteKey(key);
            this._errorsMap.delete(key);
            this._timestamps.delete(key);
            this._activeFetchPromises.delete(key);

            if (this._itemsCache.size < maxItems) {
                return;
            }
        }

        // Phase 2: Remove oldest valid items (skip in-flight items)
        while (this._itemsCache.size >= maxItems) {
            let oldestKey: string | null = null;
            let oldestTs = Infinity;

            for (const [key, ts] of this._timestamps.entries()) {
                // Don't evict the incoming key or items currently being fetched
                if (key === incomingKey) continue;
                if (this._fetchCache.has(key)) continue;

                if (ts < oldestTs) {
                    oldestTs = ts;
                    oldestKey = key;
                }
            }

            if (oldestKey != null) {
                this._deleteKey(oldestKey);
                this._timestamps.delete(oldestKey);
                this._errorsMap.delete(oldestKey);
                this._activeFetchPromises.delete(oldestKey);
            } else {
                // No evictable items found (all are in-flight or incoming)
                break;
            }
        }
    }
}
