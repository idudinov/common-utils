import type {
    FetchRequestHandler,
    IControllablePromiseCache,
    PromiseCacheEvent,
    PromiseCacheRemovedEvent,
    PromiseCacheStoredEvent,
} from '../types.js';

/**
 * Cross-cutting behavior pluggable into a promise cache via `extend()`, mirroring
 * `ILazyPromiseExtension` at the collection level.
 */
export interface IPromiseCacheExtension<T, TKey extends string = string, TExtShape extends object = object> {
    /**
     * Installs a handler in the fetch chain; handlers run newest-outermost, with the constructor's fetcher innermost.
     * A handler continues inward with `request.next()`, or returns a value to substitute the result without it.
     */
    overrideFetcher?: (target: IControllablePromiseCache<T, TKey, T | undefined> & TExtShape) => FetchRequestHandler<T, TKey>;

    /**
     * Augments the instance with extra properties/methods.
     *
     * Must augment `previous` in place and return that same reference — `extend()` throws otherwise.
     */
    extendShape?: (previous: IControllablePromiseCache<T, TKey, T | undefined>) => IControllablePromiseCache<T, TKey, T | undefined> & TExtShape;

    /** Direct handler of the cache's {@link PromiseCacheStoredEvent}. */
    onStored?: (e: PromiseCacheStoredEvent<T, TKey>) => void;

    /** Direct handler of the cache's {@link PromiseCacheRemovedEvent}. */
    onRemoved?: (e: PromiseCacheRemovedEvent<T, TKey>) => void;

    /** Direct handler of the cache's {@link PromiseCacheEvent}. */
    onCleared?: (e: PromiseCacheEvent<T, TKey>) => void;

    /** Releases resources held by the extension. Called by `dispose()`, newest extension first. */
    dispose?: () => void;
}
