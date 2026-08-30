import { DebounceProcessor } from '../../functions/debounce.js';
import type { IControllablePromiseCache, PromiseCacheFetcher } from './types.js';

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

/**
 * Collects individual fetches within `delay` ms and dispatches them as one `batchFetcher` call.
 * Falls back to the original fetcher for a key when the batch call fails, or resolves without
 * a result at that key's index — `refreshing` is only forwarded on this fallback path.
 */
export function createBatchingExtension<T, TKey extends string = string>(
    batchFetcher: (keys: TKey[]) => Promise<T[]>,
    delay = 200,
): IPromiseCacheExtension<T, TKey> {
    let processor: DebounceProcessor<TKey, T[]> | null = null;

    return {
        overrideFetcher: original => {
            processor = new DebounceProcessor<TKey, T[]>(batchFetcher, delay);

            return async (key, refreshing) => {
                const res = await processor!.push(key).catch(() => null);
                if (!res?.result || res.result[res.index] === undefined) {
                    return original(key, refreshing);
                }
                return res.result[res.index];
            };
        },
        onCleared: () => {
            processor?.clear();
        },
    };
}

/**
 * Caps the cache at `maxItems`, evicting on every store: invalid entries first, then the oldest
 * by insertion order. In-flight keys and the key that was just stored are never evicted.
 * Eviction removes via `invalidate(key, 'silent')`, so other extensions' `onInvalidated` do not fire for it.
 */
export function createEvictionExtension<T, TKey extends string = string>(
    config: { maxItems: number },
): IPromiseCacheExtension<T, TKey> {
    const order = new Map<TKey, true>();

    const findInvalidCandidate = (target: IControllablePromiseCache<T, TKey, T | undefined>, justStoredKey: TKey): TKey | undefined => {
        for (const key of target.keys()) {
            if (key === justStoredKey) continue;
            if (target.getPendingState(key) != null) continue;
            if (!target.getIsValid(key)) return key;
        }
        return undefined;
    };

    const findOldestCandidate = (target: IControllablePromiseCache<T, TKey, T | undefined>, justStoredKey: TKey): TKey | undefined => {
        for (const key of order.keys()) {
            if (key === justStoredKey) continue;
            if (target.getPendingState(key) != null) continue;
            return key;
        }
        return undefined;
    };

    return {
        onStored: (key, _value, target) => {
            order.delete(key);
            order.set(key, true);

            while (target.keys().length > config.maxItems) {
                const candidate = findInvalidCandidate(target, key) ?? findOldestCandidate(target, key);
                if (candidate === undefined) break;

                order.delete(candidate);
                target.invalidate(candidate, 'silent');
            }
        },
        onInvalidated: key => {
            order.delete(key);
        },
        onCleared: () => {
            order.clear();
        },
    };
}
