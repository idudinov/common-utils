import { DebounceProcessor } from '../../../functions/debounce.js';
import type { IPromiseCacheExtension } from './types.js';

/**
 * Collects individual fetches within `delay` ms and dispatches them as one `batchFetcher` call.
 * Falls back to the original fetcher for a key when the batch call fails, or resolves without
 * a result at that key's index — `refreshing` is only forwarded on this fallback path.
 *
 * @param onBatchError Called once per failed batch with that batch's full key list and the error. When omitted, batch failures degrade silently to per-key fetches.
 */
export function createBatchingExtension<T, TKey extends string = string>(
    batchFetcher: (keys: TKey[]) => Promise<T[]>,
    delay = 200,
    onBatchError?: (keys: TKey[], error: unknown) => void,
): IPromiseCacheExtension<T, TKey> {
    let processor: DebounceProcessor<TKey, T[]> | null = null;

    const guardedBatchFetcher = async (keys: TKey[]): Promise<T[]> => {
        try {
            return await batchFetcher(keys);
        } catch (error) {
            try {
                onBatchError?.(keys, error);
            } catch {
                // A throwing onBatchError does not affect the per-key fallback.
            }
            throw error;
        }
    };

    return {
        overrideFetcher: () => {
            processor = new DebounceProcessor<TKey, T[]>(guardedBatchFetcher, delay);

            return async request => {
                const res = await processor!.push(request.key).catch(() => null);
                if (!res?.result || res.result[res.index] === undefined) {
                    return request.next();
                }
                return res.result[res.index];
            };
        },
        onCleared: () => {
            processor?.clear();
        },
    };
}
