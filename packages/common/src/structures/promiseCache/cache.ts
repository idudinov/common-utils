import type { IDisposable } from '../../functions/disposer.js';
import { deriveIsLoading, passivePendingKind, refreshPendingKind, viewLoadingState } from '../../lazy/loadingState.js';
import type { ILazyPromise, LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
import { Loggable } from '../../logger/loggable.js';
import { Model } from '../../models/Model.js';
import type { IMapModel, IValueModel } from '../../models/types.js';
import type { IPromiseCacheExtension } from './extensions.js';
import { isInvalidated } from './invalidation.js';
import { PromiseCacheLazyHandle } from './lazyHandle.js';
import type { ErrorCallback, IControllablePromiseCache, InvalidationConfig, InvalidationMode, PromiseCacheFetcher, PromiseCacheOptions, PromiseCacheStorageProvider } from './types.js';

/** Default storage provider: plain `Map`s and a `Model` box. */
const defaultStorageProvider: PromiseCacheStorageProvider = {
    createMap: <K, V>() => new Map<K, V>(),
    createValue: <V>(initial: V) => new Model<V>(initial),
};

/**
 * Caches items by a string key, resolved by an async fetcher (`Promise`).
 *
 * Supports:
 *  - direct manual cache manipulation.
 *  - auto-invalidation of cached items (time-based, callback-based).
 *  - error tracking per key.
 *  - extension via `extend()` for batching, eviction, retry, and other cross-cutting behavior.
*/
export class PromiseCache<T, TKey extends string = string, TInitial extends T | undefined = undefined> extends Loggable implements IControllablePromiseCache<T, TKey, TInitial>, IDisposable {

    /** Stores resolved items in map by key. */
    protected readonly _itemsCache: IMapModel<string, T>;

    /** Stores items loading state in map by key: pending kind while in flight, `false` once settled, absent if never started. */
    protected readonly _itemsStatus: IMapModel<string, false | PendingLoadState>;

    /** Stores items loading count. */
    protected readonly _loadingCount: IValueModel<number>;

    /** Stores items Promises state (if still loading) in map by key. */
    protected readonly _fetchCache: IMapModel<string, Promise<T | TInitial>>;

    /** Stores last errors by key. Observable-friendly via IMapModel. */
    protected readonly _errorsMap: IMapModel<string, unknown>;

    /** Stores items resolve timestamps (for expiration) in map by key. */
    protected readonly _timestamps = new Map<string, number>();

    /**
     * Tracks the latest in-flight factory promise per key for "latest wins" refresh semantics.
     * Separate from `_fetchCache` (which stores the public-facing promise returned to callers).
     */
    protected readonly _activeFetchPromises = new Map<string, Promise<T | TInitial>>();

    protected _version = 0;

    private readonly _loadingStrategy: IValueModel<LoadingStateStrategy | undefined>;

    private readonly _prepareValue: (value: T) => T;

    /** Runs a group of mutations as one change batch and returns `fn`'s result; identity if none was supplied. */
    private readonly _transaction: <R>(fn: () => R) => R;

    private _fetcher: PromiseCacheFetcher<T, TKey>;

    private readonly _onStoredHooks: ((key: TKey, value: T, target: IControllablePromiseCache<T, TKey, T | undefined>) => void)[] = [];
    private readonly _onInvalidatedHooks: ((key: TKey, target: IControllablePromiseCache<T, TKey, T | undefined>) => void)[] = [];
    private readonly _onClearedHooks: ((target: IControllablePromiseCache<T, TKey, T | undefined>) => void)[] = [];
    private _ownDisposer: (() => void) | undefined;

    private _invalidationConfig: InvalidationConfig<T> | null = null;
    private _onError: ErrorCallback<TKey> | null = null;
    private _initialValueFactory: ((key: TKey) => TInitial) | null = null;

    /**
     * Creates an instance of PromiseCache.
     * @param fetcher Function to fetch data by key.
     * @param options Storage provider and value preparation hook. See {@link PromiseCacheOptions}.
     */
    constructor(
        fetcher: PromiseCacheFetcher<T, TKey>,
        options?: PromiseCacheOptions<T>,
    ) {
        super();

        this._fetcher = fetcher;

        const storage = options?.storage ?? defaultStorageProvider;
        this._prepareValue = options?.prepareValue ?? (value => value);
        this._transaction = storage.transaction?.bind(storage) ?? (fn => fn());

        this._loadingCount = storage.createValue(0);
        this._loadingStrategy = storage.createValue<LoadingStateStrategy | undefined>(undefined);
        this._itemsCache = storage.createMap<string, T>();
        this._itemsStatus = storage.createMap<string, false | PendingLoadState>();
        this._fetchCache = storage.createMap<string, Promise<T | TInitial>>();
        this._errorsMap = storage.createMap<string, unknown>();
    }

    // --- Configuration ---

    /**
     * Configures the per-pending-state `isLoading` override; missing keys fall back to {@link DEFAULT_LOADING_STATE}.
     * Applies to every key. The strategy is stored as-is (not copied), so getter-based fields are
     * re-evaluated on each read. Subsequent calls replace the previous strategy, not merge with it.
     */
    useLoadingState(strategy: LoadingStateStrategy): this {
        this._loadingStrategy.value = strategy;
        return this;
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
     * @param callback The callback to call on error. Receives the key and the raw error.
     */
    useOnError(callback: ErrorCallback<TKey> | null) {
        this._onError = callback;
        return this;
    }

    /**
     * Sets a default/initial value returned before the fetch completes or on error when no stale value exists.
     *
     * Accepts either a static value or a per-key factory function `(key: TKey) => TInitial`.
     * The value is **not** stored in the cache — it's a synthetic default (same as `LazyPromise`'s initial value).
     *
     * **Note:** Functions are always interpreted as factories. If `T` is a function type,
     * wrap it: `useInitialValue((key) => myFallbackFn)`.
     *
     * @param initial A value (non-function) or `(key: TKey) => TInitial` factory.
     * @returns `this` for chaining.
     */
    useInitialValue<TNewInitial extends T | undefined>(initial: TNewInitial | ((key: TKey) => TNewInitial)) {
        const self = this as unknown as PromiseCache<T, TKey, TNewInitial>;
        self._initialValueFactory = typeof initial === 'function'
            ? initial as (key: TKey) => TNewInitial
            : (_key: TKey) => initial;
        return self;
    }

    // --- Extensions ---

    /**
     * Extends this instance with additional functionality via in-place mutation, per the given
     * {@link IPromiseCacheExtension}. Extensions chain: calling `extend()` again wraps on top of
     * the previous one, in the order they were applied.
     *
     * @param extension Extension configuration.
     * @returns The same instance, typed with the extension's shape additions if any.
     */
    extend<TExtShape extends object = object>(
        // Partial allows extensions with extra properties beyond the interface
        // 'any' type parameter doesn't affect return type since we return 'this'
        extension: Partial<IPromiseCacheExtension<T, TKey, TExtShape>>,
    ): object extends TExtShape ? this : this & TExtShape {

        let extended = this as this & TExtShape;

        if (extension.extendShape) {
            const result = extension.extendShape(this);
            if (result !== (this as unknown)) {
                throw new Error('extendShape must augment the given instance in place and return it');
            }
            extended = result as this & TExtShape;
        }

        if (extension.overrideFetcher) {
            this._fetcher = extension.overrideFetcher(this._fetcher, extended);
        }

        if (extension.onStored) {
            this._onStoredHooks.push(extension.onStored);
        }

        if (extension.onInvalidated) {
            this._onInvalidatedHooks.push(extension.onInvalidated);
        }

        if (extension.onCleared) {
            this._onClearedHooks.push(extension.onCleared);
        }

        if (extension.dispose) {
            const previousDisposer = this._ownDisposer;
            const nextDisposer = extension.dispose;

            this._ownDisposer = () => {
                nextDisposer();
                previousDisposer?.();
            };
        }

        return extended;
    }

    /**
     * Runs registered extension disposers newest-first, then clears the cache — so every extension's
     * `onCleared` hook still fires during disposal, seeing the same state a plain `clear()` would produce.
     */
    dispose() {
        this._ownDisposer?.();
        this.clear();
    }

    // --- Counts ---

    /**
     * Returns the number of items currently being fetched, including background refreshes.
     *
     * Counts every in-flight fetch, regardless of the configured {@link LoadingStateStrategy} —
     * suitable for a global "something is loading" indicator.
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

    protected getLoggerName(name: string | undefined): string {
        return `[PromiseCache:${name || '?'}]`;
    }

    // --- Public API: reading ---

    getLazy(key: TKey, strategy?: LoadingStateStrategy): ILazyPromise<T, TInitial> {
        const handle = new PromiseCacheLazyHandle<T, TInitial>(this, key);
        return strategy ? viewLoadingState(handle, strategy) : handle;
    }

    getIsLoading(key: TKey): boolean | null {
        const res = this._itemsStatus.get(key);
        if (res) {
            return deriveIsLoading(res, this._loadingStrategy.value);
        }
        return res ?? null;
    }

    getIsValid(key: TKey): boolean {
        return this._itemsCache.has(key) && !this.getIsInvalidated(key);
    }

    getLastError(key: TKey): unknown {
        return this._errorsMap.get(key) ?? null;
    }

    getPendingState(key: TKey): PendingLoadState | null {
        return this._itemsStatus.get(key) || null;
    }

    getHasValue(key: TKey): boolean {
        return this._itemsCache.has(key) && !this._errorsMap.has(key);
    }

    getCurrent(key: TKey, initiateFetch = true): T | TInitial {
        if (initiateFetch) {
            this.get(key);
        }
        const result = this._getCachedOrInitial(key);
        this.logger.log(key, 'getCurrent: returns', result);
        return result;
    }

    get(key: TKey): Promise<T | TInitial> {
        const hasCached = this._itemsCache.has(key);

        // return cached item if it's not invalidated
        if (hasCached && !this.getIsInvalidated(key)) {
            const item = this._itemsCache.get(key)!;
            this.logger.log(key, 'get: item resolved to', item);
            return Promise.resolve(item);
        }

        // Join an existing in-flight fetch/refresh if one exists
        const existingPromise = this._fetchCache.get(key);
        if (existingPromise != null) {
            this.logger.log(key, 'get: item resolved to <promise>');
            return existingPromise;
        }

        // If a fetch is in progress or already completed (with error) and not invalidated,
        // don't start a new fetch — error is "sticky". Use refresh() or invalidate() to retry.
        if (this._itemsStatus.has(key) && !this.getIsInvalidated(key)) {
            const status = this._itemsStatus.get(key);
            this.logger.log(key, 'get: fetch already', status ? 'in progress' : 'completed (error)', '— returning initial value');
            return Promise.resolve(this._getInitialValue(key));
        }

        return this._transaction(() => {
            this.setStatus(key, passivePendingKind(hasCached));
            const promise = this._doFetchAsync(key, false);
            this.setPromise(key, promise);
            return promise;
        });
    }

    refresh(key: TKey): Promise<T | TInitial> {
        const current = this._itemsStatus.get(key) || null;

        return this._transaction(() => {
            this.setStatus(key, refreshPendingKind(current, this._itemsCache.has(key)));
            const promise = this._doFetchAsync(key, true);
            this.setPromise(key, promise);
            return promise;
        });
    }

    hasKey(key: TKey) {
        return this._itemsCache.has(key) || this._itemsStatus.has(key);
    }

    /** Returns an iterator over the keys of the cached items. */
    keys(iterate: true): MapIterator<TKey>;

    /** Returns an array of the keys of the cached items. */
    keys(): TKey[];

    keys(iterate: boolean = false) {
        const iterator = this._itemsCache.keys() as MapIterator<TKey>;
        return iterate
            ? iterator
            : Array.from(iterator);
    }

    // --- Public API: mutation ---

    invalidate(key: TKey, mode: InvalidationMode = 'notify') {
        this._transaction(() => {
            this._deleteKey(key);
            this._errorsMap.delete(key);
            this._timestamps.delete(key);
            this._activeFetchPromises.delete(key);
        });

        if (mode === 'notify') {
            this._fireHooks(this._onInvalidatedHooks, key, this);
        }
    }

    set(key: TKey, value: T) {
        const prepared = this._prepareValue(value);

        this._transaction(() => {
            this._fetchCache.delete(key);
            this.setStatus(key, false);
            this._itemsCache.set(key, prepared);
            this._timestamps.set(key, Date.now());
            this._errorsMap.delete(key);
            this._activeFetchPromises.delete(key);
        });

        this._fireHooks(this._onStoredHooks, key, prepared, this);
    }

    /**
     * Iterates over all cached items and removes those that are invalid (expired).
     *
     * @returns The number of items that were removed.
     */
    sanitize(): number {
        const keysToRemove: string[] = [];

        for (const key of this._itemsCache.keys()) {
            if (this.getIsInvalidated(key)) {
                keysToRemove.push(key);
            }
        }

        return this._transaction(() => {
            for (const key of keysToRemove) {
                this._deleteKey(key);
                this._errorsMap.delete(key);
                this._timestamps.delete(key);
                this._activeFetchPromises.delete(key);
            }
            return keysToRemove.length;
        });
    }

    clear() {
        this._transaction(() => {
            ++this._version;
            this._loadingCount.value = 0;

            this._itemsCache.clear();
            this._itemsStatus.clear();
            this._fetchCache.clear();
            this._errorsMap.clear();
            this._timestamps.clear();
            this._activeFetchPromises.clear();
        });

        this._fireHooks(this._onClearedHooks, this);
    }

    // --- Protected hooks ---

    /** Returns the cached value if present, otherwise the initial value for the key. */
    protected _getCachedOrInitial(key: TKey): T | TInitial {
        return this._itemsCache.has(key)
            ? this._itemsCache.get(key)!
            : this._getInitialValue(key);
    }

    /** Checks if the cached item for the specified key is invalidated (expired), per the configured {@link InvalidationConfig}. */
    protected getIsInvalidated(key: string): boolean {
        return isInvalidated(
            this._invalidationConfig,
            key,
            () => ({ has: this._itemsCache.has(key), value: this._itemsCache.get(key) }),
            this._timestamps.get(key),
        );
    }

    /** Returns the initial/default value for a key. Used as fallback when no cached value exists. */
    protected _getInitialValue(key: TKey): TInitial {
        return this._initialValueFactory
            ? this._initialValueFactory(key)
            : undefined as TInitial;
    }

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

    // --- Private ---

    /** Runs `hooks` in order, isolating each from the others' and its own failures. */
    private _fireHooks<TArgs extends unknown[]>(hooks: ((...args: TArgs) => void)[], ...args: TArgs): void {
        for (const hook of hooks) {
            try {
                hook(...args);
            } catch (err) {
                this.logger.warn('extension hook failed', err);
            }
        }
    }

    /**
     * Unified fetch method with "latest wins" semantics.
     *
     * - Tracks the active factory promise per key via `_activeFetchPromises`.
     * - If superseded by a newer fetch, delegates to the newer promise.
     * - On error, preserves the stale cached value.
     * - The error is recorded only once classification is known — a superseded/cancelled fetch's
     *   error is discarded rather than overwriting a newer fetch's already-settled state.
     *
     * @param key The cache key.
     * @returns A promise resolving to the fetched/refreshed value, or the stale value on error.
     */
    protected async _doFetchAsync(key: TKey, refreshing: boolean): Promise<T | TInitial> {
        const { factoryPromise, v } = this._transaction(() => {
            this.onBeforeFetch(key);

            let factoryResult: Promise<T> | T;
            try {
                factoryResult = this._fetcher(key, refreshing);
            } catch (err) {
                // Re-throwing the original error from a synchronous fetcher
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                factoryResult = Promise.reject(err);
            }
            const promise = Promise.resolve(factoryResult);

            this._activeFetchPromises.set(key, promise);

            return { factoryPromise: promise, v: this._version };
        });

        let fetchResult: { ok: true; value: T } | { ok: false; error: unknown };
        try {
            fetchResult = { ok: true, value: await factoryPromise };
        } catch (err) {
            fetchResult = { ok: false, error: err };
        }

        if (v !== this._version) {
            this._transaction(() => {
                this._activeFetchPromises.delete(key);
            });
            this.logger.log(key, 'skipping item\'s resolve due to version change ("clear()" has been called)');
            // resolve with actual result but don't store it
            return fetchResult.ok ? fetchResult.value : this._getInitialValue(key);
        }

        // Check if this is still the active (latest) fetch for this key
        const currentActive = this._activeFetchPromises.get(key);

        if (currentActive !== factoryPromise) {
            if (currentActive != null) {
                // Superseded by a newer refresh/fetch — delegate to the latest promise
                this._transaction(() => this.onFetchSuperseded(key));
                const newerPromise = this._fetchCache.get(key);
                return newerPromise
                    ? newerPromise.catch(() => this._getCachedOrInitial(key))
                    : this._getCachedOrInitial(key);
            }

            // Active promise removed by set()/invalidate() — clean up
            // in-flight bookkeeping without restoring _itemsStatus.
            this._transaction(() => this.onFetchCancelled(key));
            return this._getCachedOrInitial(key);
        }

        if (fetchResult.ok) {
            const res = this._prepareValue(fetchResult.value);
            this.logger.log(key, 'item\'s <promise> resolved to', res);

            this._transaction(() => {
                this._activeFetchPromises.delete(key);
                this.storeResult(key, res);
                this.onFetchComplete(key);
            });

            this._fireHooks(this._onStoredHooks, key, res, this);
            return res;
        }

        // Fetch failed — record the error and a timestamp for time-based invalidation expiry,
        // then return stale value or initial.
        this._transaction(() => {
            this._activeFetchPromises.delete(key);
            this._handleError(key, fetchResult.error);
            this._timestamps.set(key, Date.now());
            this.onFetchComplete(key);
        });
        return this._getCachedOrInitial(key);
    }

    /** Handles a fetch error: stores it, logs it, and calls the onError callback. */
    protected _handleError(key: TKey, err: unknown) {
        this._errorsMap.set(key, err);
        this.logger.warn('fetcher failed', key, err);

        if (this._onError) {
            try {
                this._onError(key, err);
            } catch {
                // ignore errors in the callback
            }
        }
    }
}
