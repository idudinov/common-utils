import type { IControllablePromiseCache } from '../types.js';
import type { IPromiseCacheExtension } from './types.js';

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
