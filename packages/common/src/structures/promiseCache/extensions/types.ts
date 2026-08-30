import type { IControllablePromiseCache, PromiseCacheFetcher } from '../types.js';

/**
 * Cross-cutting behavior pluggable into a {@link PromiseCache} via `extend()`, mirroring
 * {@link ILazyPromiseExtension} at the collection level.
 */
export interface IPromiseCacheExtension<T, TKey extends string = string, TExtShape extends object = object> {
    /** Wraps or replaces the fetcher (retry, read-through cache, batching, ...). */
    overrideFetcher?: (original: PromiseCacheFetcher<T, TKey>, target: IControllablePromiseCache<T, TKey, T | undefined> & TExtShape) => PromiseCacheFetcher<T, TKey>;

    /**
     * Augments the instance with extra properties/methods.
     *
     * Must augment `previous` in place and return that same reference — `extend()` throws otherwise.
     */
    extendShape?: (previous: IControllablePromiseCache<T, TKey, T | undefined>) => IControllablePromiseCache<T, TKey, T | undefined> & TExtShape;

    /** Fires after every successful store — fetch result and manual `set()` — with the stored (prepared) value. */
    onStored?: (key: TKey, value: T, target: IControllablePromiseCache<T, TKey, T | undefined>) => void;

    /** Fires after `invalidate(key, 'notify')` removes the key. Does not fire for `'silent'` invalidation, `sanitize()`, or `clear()`. */
    onInvalidated?: (key: TKey, target: IControllablePromiseCache<T, TKey, T | undefined>) => void;

    /** Fires after `clear()` resets the cache. */
    onCleared?: (target: IControllablePromiseCache<T, TKey, T | undefined>) => void;

    /** Releases resources held by the extension. Called by `dispose()`, newest extension first. */
    dispose?: () => void;
}
