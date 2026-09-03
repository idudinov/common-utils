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
 * Reads:
 * - a cold read — the cache holds neither a value nor a stored error for the key, and it's not a
 *   `refresh()` — checks `storage` first
 * - a hit is served without calling the fetcher and without writing back, so a wrapper that stamps
 *   write-side metadata (e.g. an expiry) keeps its stamp
 * - a miss, a `refresh()`, or a revalidation of a key the cache already has state for falls through
 *   to the fetcher, and its result is written to `storage`
 *
 * Errors:
 * - a throwing `storage.getValue` is recorded as the key's fetch error
 * - `setValue`/`removeValue` errors are logged and swallowed
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
            delete context[FromStorage];
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
