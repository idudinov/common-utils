import type { IStorageSync } from '../../../storage/types.js';
import type { IPromiseCacheExtension } from './types.js';

export interface StorageCacheExtensionOptions<TKey extends string = string> {
    /** Maps a cache key to its storage key. Defaults to identity. */
    storageKey?: (key: TKey) => string;

    /** Clears the whole storage scope on `clear()`. Without it, `clear()` leaves storage untouched. */
    clearStorage?: () => void;
}

/**
 * Read-through/write-through persistence for a {@link PromiseCache}, backed by a synchronous
 * {@link IStorageSync}.
 *
 * A cold read — the cache holds neither a value nor a stored error for the key, and it's not a
 * `refresh()` — checks `storage` first; a hit is served without calling the original fetcher.
 * A miss, a `refresh()`, or a revalidation of a key the cache already has state for falls through
 * to the original fetcher, and its result is written to `storage`. A storage-served hit is written
 * back too — a harmless same-value write.
 *
 * Known accepted edge: `expire()` called on a key that was never successfully fetched still reads
 * `storage` on the next fetch, since expiring doesn't clear the "cold" state — `refresh()` is the
 * way to force a network call for such a key.
 *
 * `storage` is assumed non-throwing: this extension never catches, so a throwing implementation
 * propagates the error out of whichever cache operation triggered it.
 */
export function createStorageCacheExtension<T, TKey extends string = string>(
    storage: IStorageSync<T | null>,
    options?: StorageCacheExtensionOptions<TKey>,
): IPromiseCacheExtension<T, TKey> {
    const toStorageKey = options?.storageKey ?? ((key: TKey) => key);

    return {
        overrideFetcher: (original, target) => (key, refreshing) => {
            if (!refreshing && !target.getHasValue(key) && target.getLastError(key) == null) {
                const cached = storage.getValue(toStorageKey(key));
                if (cached != null) {
                    return Promise.resolve(cached);
                }
            }
            return original(key, refreshing);
        },
        onStored: (key, value) => {
            storage.setValue(toStorageKey(key), value);
        },
        onRemoved: key => {
            storage.removeValue(toStorageKey(key));
        },
        onCleared: () => {
            options?.clearStorage?.();
        },
    };
}
