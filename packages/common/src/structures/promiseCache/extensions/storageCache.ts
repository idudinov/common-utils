import type { IStorageSync } from '../../../storage/types.js';
import type { IPromiseCacheExtension } from './types.js';

export interface StorageCacheExtensionOptions<TKey extends string = string> {
    /** Maps a cache key to its storage key. Defaults to identity. */
    storageKey?: (key: TKey) => string;

    /** Clears the whole storage scope on `clear()`. Without it, `clear()` leaves storage untouched. */
    clearStorage?: () => void;
}

/** Marks a fetch attempt whose result was served from storage. */
const FromStorage = Symbol('storageCache:fromStorage');

/**
 * Read-through/write-through persistence for a {@link PromiseCache}, backed by a synchronous
 * {@link IStorageSync}.
 *
 * A cold read — the cache holds neither a value nor a stored error for the key, and it's not a
 * `refresh()` — checks `storage` first; a hit is served without calling the fetcher and without
 * writing back (a write-back would re-stamp write-side metadata such as an expiry). A miss, a
 * `refresh()`, or a revalidation of a key the cache already has state for falls through to the
 * fetcher, and its result is written to `storage`.
 *
 * Known accepted edge: `expire()` called on a key that was never successfully fetched still reads
 * `storage` on the next fetch — `refresh()` is the way to force a network call for such a key.
 *
 * A throwing `storage.getValue` is recorded as the key's fetch error; errors from
 * `setValue`/`removeValue` are logged and swallowed.
 */
export function createStorageCacheExtension<T, TKey extends string = string>(
    storage: IStorageSync<T | null>,
    options?: StorageCacheExtensionOptions<TKey>,
): IPromiseCacheExtension<T, TKey> {
    const toStorageKey = options?.storageKey ?? ((key: TKey) => key);

    return {
        overrideFetcher: (original, target) => request => {
            const { key, refreshing, context } = request;
            if (!refreshing && !target.getHasValue(key) && target.getLastError(key) == null) {
                const cached = storage.getValue(toStorageKey(key));
                if (cached != null) {
                    context[FromStorage] = true;
                    return cached;
                }
            }
            return original(request);
        },
        onStored: ({ key, value, context }) => {
            if (context?.[FromStorage]) {
                return;
            }
            storage.setValue(toStorageKey(key), value);
        },
        onRemoved: ({ key }) => {
            storage.removeValue(toStorageKey(key));
        },
        onCleared: () => {
            options?.clearStorage?.();
        },
    };
}
