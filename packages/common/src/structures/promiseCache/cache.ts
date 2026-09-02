import { combineDisposers, type IDisposable } from '../../functions/disposer.js';
import { deriveIsLoading, passivePendingKind, refreshPendingKind, viewLoadingState } from '../../lazy/loadingState.js';
import type { ILazyPromise, LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
import { Loggable } from '../../logger/loggable.js';
import type { ILogger } from '../../logger/types.js';
import { Model } from '../../models/Model.js';
import type { IMapModel, IValueModel } from '../../models/types.js';
import { Event, type IEvent } from '../../observing/event.js';
import type { Getter } from '../../types/getter.js';
import type { Nullable } from '../../types/misc.js';
import { applyExtensionShape } from '../extension.js';
import type { IPromiseCacheExtension } from './extensions/index.js';
import { isInvalidated } from './invalidation.js';
import { PromiseCacheLazyHandle } from './lazyHandle.js';
import type { ErrorCallback, IControllablePromiseCache, InvalidationConfig, PromiseCacheFetcher, PromiseCacheOptions, PromiseCacheStorageProvider } from './types.js';

/** Default storage provider: plain `Map`s and a `Model` box. */
const defaultStorageProvider: PromiseCacheStorageProvider = {
    createMap: <K, V>() => new Map<K, V>(),
    createValue: <V>(initial: V) => new Model<V>(initial),
};

/** Sentinel timestamp marking a force-expired key; `Date.now()` never produces it, so it's safe to check by identity. */
const EXPIRED_TIMESTAMP = -Infinity;

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

    // Each concern lives in its own map so that reactive storage subscribes per concern:
    // writing to one (e.g. a resolved value) does not invalidate reads of another (e.g. loading state).

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

    /** Stores items resolve timestamps (for expiration) in map by key. `-Infinity` marks a force-expired key. */
    protected readonly _timestamps = new Map<string, number>();

    /** Tracks the latest in-flight factory promise per key, used to decide which settle wins ("latest wins" refresh semantics). */
    protected readonly _activeFetchPromises = new Map<string, Promise<T | TInitial>>();

    protected _version = 0;

    private readonly _loadingStrategy: IValueModel<LoadingStateStrategy | undefined>;

    private readonly _prepareValue: (value: T) => T;

    /** Runs a group of mutations as one change batch and returns `fn`'s result; identity if none was supplied. */
    private readonly _transaction: <R>(fn: () => R) => R;

    private _fetcher: PromiseCacheFetcher<T, TKey>;

    private readonly _onStored = new Event<{ key: TKey; value: T }>();
    private readonly _onRemoved = new Event<{ key: TKey }>();
    private readonly _onCleared = new Event<void>();
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

    // --- Events ---

    /** Fires after every successful store — fetch result and manual `set()` — with the stored (prepared) value. */
    public get onStored(): IEvent<{ key: TKey; value: T }> { return this._onStored.expose(); }

    /** Fires for every per-key removal: `delete()` and `sanitize()`. Not for `clear()`. */
    public get onRemoved(): IEvent<{ key: TKey }> { return this._onRemoved.expose(); }

    /** Fires after `clear()` resets the cache. */
    public get onCleared(): IEvent<void> { return this._onCleared.expose(); }

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

        const extended = applyExtensionShape<this, TExtShape>(
            this,
            extension.extendShape as ((previous: this) => this & TExtShape) | undefined,
        );

        if (extension.overrideFetcher) {
            this._fetcher = extension.overrideFetcher(this._fetcher, extended);
        }

        if (extension.onStored) {
            const hook = extension.onStored;
            this._onStored.on(p => hook(p.key, p.value, extended));
        }

        if (extension.onRemoved) {
            const hook = extension.onRemoved;
            this._onRemoved.on(p => hook(p.key, extended));
        }

        if (extension.onCleared) {
            const hook = extension.onCleared;
            this._onCleared.on(() => hook(extended));
        }

        if (extension.dispose) {
            this._ownDisposer = combineDisposers(extension.dispose, this._ownDisposer);
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

    /** Forwards the resolved logger to the {@link onStored}, {@link onRemoved}, and {@link onCleared} events, so their handler failures log through it too. */
    override setLogger(logger: Getter<Nullable<ILogger>>): this {
        super.setLogger(logger);
        this._onStored.setLogger(this.logger);
        this._onRemoved.setLogger(this.logger);
        this._onCleared.setLogger(this.logger);
        return this;
    }

    // --- Public API: reading ---

    getLazy(key: TKey, strategy?: LoadingStateStrategy): ILazyPromise<T, TInitial> {
        this._assertKey(key);
        const handle = this.createLazyHandle(key);
        return strategy ? viewLoadingState(handle, strategy) : handle;
    }

    /** Constructs the {@link ILazyPromise} handle returned by {@link getLazy}. Override to supply a custom handle implementation. */
    protected createLazyHandle(key: string): ILazyPromise<T, TInitial> {
        return new PromiseCacheLazyHandle(this, key);
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
        this._assertKey(key);

        const hasCached = this._itemsCache.has(key);
        const isInvalidated = this.getIsInvalidated(key);

        // return cached item if it's not invalidated
        if (hasCached && !isInvalidated) {
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
        // don't start a new fetch — error is "sticky". Use refresh() or delete() to retry.
        if (this._itemsStatus.has(key) && !isInvalidated) {
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
        this._assertKey(key);

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

    delete(key: TKey): boolean {
        const hadState = this._hasAnyKeyState(key);

        this._transaction(() => {
            this._purgeKey(key);
        });

        if (hadState) {
            this._onRemoved.trigger({ key });
        }

        return hadState;
    }

    expire(key: TKey): void {
        this._assertKey(key);
        if (!this.hasKey(key)) {
            return;
        }
        this._transaction(() => {
            this._timestamps.set(key, EXPIRED_TIMESTAMP);
            if (this._activeFetchPromises.has(key)) {
                this._activeFetchPromises.delete(key);
                this._fetchCache.delete(key);
                this.setStatus(key, false);
            }
        });
    }

    set(key: TKey, value: T) {
        this._assertKey(key);

        const prepared = this._prepareValue(value);

        this._transaction(() => {
            this._fetchCache.delete(key);
            this.setStatus(key, false);
            this._itemsCache.set(key, prepared);
            this._timestamps.set(key, Date.now());
            this._errorsMap.delete(key);
            this._activeFetchPromises.delete(key);
        });

        this._onStored.trigger({ key, value: prepared });
    }

    /**
     * Iterates over all cached items and removes those that are invalid (expired).
     *
     * @returns The number of keys announced as removed. A key re-added by its own `onRemoved`
     * handler is still counted — the presence check runs before that handler fires. Only a key
     * re-added by an earlier key's handler in the same pass, before its own announcement turn, is
     * left uncounted.
     */
    sanitize(): number {
        const keysToRemove: TKey[] = [];

        for (const key of this._itemsCache.keys()) {
            if (this.getIsInvalidated(key)) {
                keysToRemove.push(key as TKey);
            }
        }

        this._transaction(() => {
            for (const key of keysToRemove) {
                this._purgeKey(key);
            }
        });

        let announced = 0;
        for (const key of keysToRemove) {
            // An earlier handler in this same loop may have re-added the key (e.g. set() inside
            // onRemoved) — it is live again and must not be announced as removed.
            if (this.hasKey(key)) {
                continue;
            }
            this._onRemoved.trigger({ key });
            announced++;
        }

        return announced;
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

        this._onCleared.trigger();
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
        if (this._timestamps.get(key) === EXPIRED_TIMESTAMP) {
            return true;
        }
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

    /** Whether any per-key map still holds state for `key` — used to decide if a removal is real. */
    private _hasAnyKeyState(key: TKey): boolean {
        return this._itemsCache.has(key)
            || this._fetchCache.has(key)
            || this._itemsStatus.has(key)
            || this._errorsMap.has(key)
            || this._timestamps.has(key)
            || this._activeFetchPromises.has(key);
    }

    /** Removes every per-key entry, across all maps. */
    protected _purgeKey(key: string) {
        this._deleteKey(key);
        this._errorsMap.delete(key);
        this._timestamps.delete(key);
        this._activeFetchPromises.delete(key);
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

    /** Hooks into cancelled fetch cleanup (set()/delete() called mid-flight). Only decrements loading count — per-key cleanup is the responsibility of the mutation that cancelled the fetch. */
    protected onFetchCancelled(_key: string) {
        this._loadingCount.value = this._loadingCount.value - 1;
    }

    // --- Private ---

    /** Throws if `key` is `null` or `undefined` (`==` catches both) — non-null non-string keys are the type system's job. */
    private _assertKey(key: TKey) {
        if (key == null) {
            throw new Error('PromiseCache: key must not be null or undefined');
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

            // An attempt consumes the forced staleness: after a failed fetch the key follows the
            // configured invalidation policy rather than retrying on every read.
            if (this._timestamps.get(key) === EXPIRED_TIMESTAMP) {
                this._timestamps.set(key, Date.now());
            }

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
                // Only delete if this fetch is still the active one — a fresh fetch started
                // after clear() may already own this key's entry.
                if (this._activeFetchPromises.get(key) === factoryPromise) {
                    this._activeFetchPromises.delete(key);
                }
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

            // Active promise removed by set()/delete() — the mutation already
            // cleaned up per-key bookkeeping; only the loading count needs decrementing.
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

            this._onStored.trigger({ key, value: res });
            return res;
        }

        // Fetch failed — record the error, then return stale value or initial. An expired value
        // whose refresh fails stays expired, so the next get() retries.
        this._transaction(() => {
            this._activeFetchPromises.delete(key);
            this._handleError(key, fetchResult.error);
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
