import type {
    FetchRequestHandler,
    IControllablePromiseCache,
    PromiseCacheEvent,
    PromiseCacheRemovedEvent,
    PromiseCacheStoredEvent,
} from '../types.js';

/**
 * Cross-cutting behavior pluggable into a {@link PromiseCache} via `extend()`, mirroring
 * {@link ILazyPromiseExtension} at the collection level.
 */
export interface IPromiseCacheExtension<T, TKey extends string = string, TExtShape extends object = object> {
    /**
     * Wraps or replaces the fetcher; wraps chain newest-outermost.
     * A request passed to `original` may be rebuilt, but must keep the incoming `context` by reference.
     */
    overrideFetcher?: (original: FetchRequestHandler<T, TKey>, target: IControllablePromiseCache<T, TKey, T | undefined> & TExtShape) => FetchRequestHandler<T, TKey>;

    /**
     * Augments the instance with extra properties/methods.
     *
     * Must augment `previous` in place and return that same reference — `extend()` throws otherwise.
     */
    extendShape?: (previous: IControllablePromiseCache<T, TKey, T | undefined>) => IControllablePromiseCache<T, TKey, T | undefined> & TExtShape;

    /** Direct handler of the cache's `onStored` event. */
    onStored?: (e: PromiseCacheStoredEvent<T, TKey>) => void;

    /** Direct handler of the cache's `onRemoved` event. */
    onRemoved?: (e: PromiseCacheRemovedEvent<T, TKey>) => void;

    /** Direct handler of the cache's `onCleared` event. */
    onCleared?: (e: PromiseCacheEvent<T, TKey>) => void;

    /** Releases resources held by the extension. Called by `dispose()`, newest extension first. */
    dispose?: () => void;
}
