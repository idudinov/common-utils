import type { IStorage, IStorageSync } from '../../../storage/types.js';
import type { IPromiseCacheExtension } from './types.js';

export interface StorageCacheExtensionOptions<TKey extends string = string> {
    /** Maps a cache key to its storage key. Defaults to identity. */
    storageKey?: (key: TKey) => string;

    /** Clears the whole storage scope on `clear()`. Without it, `clear()` leaves storage untouched. */
    clearStorage?: () => void | Promise<void>;

    /** Receives storage read/write failures; a failed read counts as a miss. Errors are swallowed without it. */
    onError?: (err: unknown, key?: TKey) => void;
}

/**
 * Read-through/write-through persistence for a {@link PromiseCache}, backed by an {@link IStorage}
 * or {@link IStorageSync}.
 *
 * A cold `get()` first checks `storage`; a hit is served without calling the original fetcher and
 * is not written back. A miss falls through to the original fetcher, and its result is written to
 * `storage`. `refresh()` always calls the original fetcher.
 *
 * Writes to `storage` (on store, removal, and `clear()`) are fire-and-forget: with an async
 * `storage`, the triggering cache operation does not wait for the write to settle.
 */
export function createStorageCacheExtension<T, TKey extends string = string>(
    storage: IStorage<T | null> | IStorageSync<T | null>,
    options?: StorageCacheExtensionOptions<TKey>,
): IPromiseCacheExtension<T, TKey> {
    const toStorageKey = options?.storageKey ?? ((key: TKey) => key);
    const onError = options?.onError;

    // Keys whose pending fetch result came from storage, so `onStored` skips echoing it back.
    // Tracked by key only: a manual set() landing while an async read-through is still in flight
    // consumes the entry, and that set() value reaches storage only with the key's next write.
    const readFromStorage = new Set<TKey>();

    const guarded = (result: unknown, key?: TKey) => {
        Promise.resolve(result).catch((err: unknown) => onError?.(err, key));
    };

    return {
        overrideFetcher: original => async (key, refreshing) => {
            if (!refreshing) {
                try {
                    const cached = await storage.getValue(toStorageKey(key));
                    if (cached != null) {
                        readFromStorage.add(key);
                        return cached;
                    }
                } catch (err) {
                    onError?.(err, key);
                }
            }
            return original(key, refreshing);
        },
        onStored: (key, value) => {
            if (readFromStorage.delete(key)) {
                return;
            }
            guarded(storage.setValue(toStorageKey(key), value), key);
        },
        onRemoved: key => {
            guarded(storage.removeValue(toStorageKey(key)), key);
        },
        onCleared: () => {
            readFromStorage.clear();
            if (options?.clearStorage) {
                guarded(options.clearStorage());
            }
        },
    };
}
