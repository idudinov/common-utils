import type { ILazyPromise, LoadingStateStrategy, PendingLoadState } from '../../lazy/types.js';
import { PromiseCache } from './cache.js';
import type { IControllablePromiseCache, InvalidationMode, PromiseCacheFetcher } from './types.js';

/**
 * Wraps a {@link PromiseCache} for a non-string key type `K`, translating ids to/from the
 * string keys the inner cache uses.
 *
 * `toKey` is required. `fromKey` is optional: when omitted, ids are recovered from an internal
 * `Map<string, K>` registry populated on every call that receives an id — so a key can only be
 * resolved back to its id after that id has been passed to at least one public method first.
 *
 * Only a subset of `PromiseCache`'s API is mirrored here (translated to take `id: K`); anything
 * else is reached via the {@link cache} getter, which works with the inner string keys.
 */
export class KeyedPromiseCache<
    T,
    TKey,
    TInitial extends T | undefined = undefined,
    TCache extends PromiseCache<T, string, TInitial> = PromiseCache<T, string, TInitial>,
> implements IControllablePromiseCache<T, TKey, TInitial> {

    private readonly _cache: TCache;
    private readonly _toKey: (id: TKey) => string;
    private readonly _fromKey?: (key: string) => TKey;
    private readonly _registry = new Map<string, TKey>();

    constructor(
        fetcher: (id: TKey, refreshing?: boolean) => Promise<T>,
        toKey: (id: TKey) => string,
        options?: {
            fromKey?: (key: string) => TKey;
            cacheFactory?: (f: PromiseCacheFetcher<T, string>) => TCache;
        },
    ) {
        this._toKey = toKey;
        this._fromKey = options?.fromKey;

        const cacheFactory = options?.cacheFactory
            ?? ((f: PromiseCacheFetcher<T, string>) => new PromiseCache<T, string, TInitial>(f) as TCache);

        this._cache = cacheFactory((key, refreshing) => fetcher(this._resolveKey(key), refreshing));
    }

    /** The wrapped cache instance, for configuration and methods not mirrored here. */
    get cache(): TCache {
        return this._cache;
    }

    get(id: TKey): Promise<T | TInitial> {
        return this._cache.get(this._registerKey(id));
    }

    refresh(id: TKey): Promise<T | TInitial> {
        return this._cache.refresh(this._registerKey(id));
    }

    getCurrent(id: TKey, initiateFetch = true): T | TInitial {
        return this._cache.getCurrent(this._registerKey(id), initiateFetch);
    }

    getLazy(id: TKey, strategy?: LoadingStateStrategy): ILazyPromise<T, TInitial> {
        return this._cache.getLazy(this._registerKey(id), strategy);
    }

    getIsLoading(id: TKey): boolean | null {
        return this._cache.getIsLoading(this._registerKey(id));
    }

    getPendingState(id: TKey): PendingLoadState | null {
        return this._cache.getPendingState(this._registerKey(id));
    }

    getHasValue(id: TKey): boolean {
        return this._cache.getHasValue(this._registerKey(id));
    }

    getLastError(id: TKey): unknown {
        return this._cache.getLastError(this._registerKey(id));
    }

    getIsValid(id: TKey): boolean {
        return this._cache.getIsValid(this._registerKey(id));
    }

    hasKey(id: TKey): boolean {
        return this._cache.hasKey(this._registerKey(id));
    }

    set(id: TKey, value: T) {
        this._cache.set(this._registerKey(id), value);
    }

    /** Invalidates the item and removes its registry entry, in either mode. */
    invalidate(id: TKey, mode?: InvalidationMode) {
        const key = this._registerKey(id);
        this._cache.invalidate(key, mode);
        this._registry.delete(key);
    }

    /** Clears the cache and the id registry. */
    clear() {
        this._cache.clear();
        this._registry.clear();
    }

    /** Returns an iterator over the ids of the cached items. */
    keys(iterate: true): MapIterator<TKey>;

    /** Returns the ids of the cached items. Raw string keys are reachable via `cache.keys()`. */
    keys(): TKey[];

    keys(iterate: boolean = false) {
        const iterator = this._mapKeys() as MapIterator<TKey>;
        return iterate
            ? iterator
            : Array.from(iterator);
    }

    /** Maps the inner cache's string keys back to ids, via `fromKey` or the registry. */
    private *_mapKeys(): Generator<TKey> {
        for (const key of this._cache.keys(true)) {
            yield this._resolveKey(key);
        }
    }

    /** Converts `id` to its string key and records it in the registry when `fromKey` is not provided. */
    private _registerKey(id: TKey): string {
        const key = this._toKey(id);
        if (!this._fromKey) {
            this._registry.set(key, id);
        }
        return key;
    }

    /** Resolves a string key back to its original id, via `fromKey` or the registry. */
    private _resolveKey(key: string): TKey {
        if (this._fromKey) {
            return this._fromKey(key);
        }

        if (!this._registry.has(key)) {
            throw new Error(`KeyedPromiseCache: no id registered for key "${key}" — pass the id to a public method (e.g. get/set) before it can be resolved back`);
        }

        return this._registry.get(key)!;
    }
}
