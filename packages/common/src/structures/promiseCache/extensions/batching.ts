import { DebounceProcessor } from '../../../functions/debounce.js';
import type { IPromiseCacheExtension } from './types.js';

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
