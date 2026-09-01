import type { IControllablePromiseCache } from '../types.js';
import type { IPromiseCacheExtension } from './types.js';

/**
 * Caps the cache at `maxItems`, evicting on every store: invalid entries first, then the oldest
 * by insertion order. In-flight keys and the key that was just stored are never evicted.
 */
export function createEvictionExtension<T, TKey extends string = string>(
    config: { maxItems: number },
): IPromiseCacheExtension<T, TKey> {
    const order = new Set<TKey>();

    const findInvalidCandidate = (target: IControllablePromiseCache<T, TKey, T | undefined>, justStoredKey: TKey): TKey | undefined => {
        for (const key of target.keys(true)) {
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
        extendShape: previous => {
            for (const key of previous.keys(true)) {
                order.add(key);
            }
            return previous;
        },
        onStored: (key, _value, target) => {
            order.delete(key);
            order.add(key);

            while (target.cachedCount > config.maxItems) {
                const candidate = findInvalidCandidate(target, key) ?? findOldestCandidate(target, key);
                if (candidate === undefined) break;

                // Delete from `order` before `delete()`: `delete()` only fires `onRemoved` for a key
                // that still has cache state, so a candidate with none would otherwise leave `order`
                // unchanged and spin this loop forever.
                order.delete(candidate);
                target.delete(candidate);
            }
        },
        onRemoved: key => {
            order.delete(key);
        },
        onCleared: () => {
            order.clear();
        },
    };
}
