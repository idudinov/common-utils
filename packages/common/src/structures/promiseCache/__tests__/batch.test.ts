
import { createBatchingExtension, PromiseCache } from '../index.js';
import { delayedError, delayedValue } from './helpers.js';
import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';

/**
 * Tests for the scenario where a batch fetcher populates the cache directly via `set()`.
 *
 * Use case:
 *  - Regular fetcher: GET /item/:id → returns one item
 *  - Batch fetcher: GET /items/all → returns all items, and populates the cache
 *    with all found items using `cache.set(id, value)` so that subsequent `get()` calls
 *    are served from cache immediately.
 */
describe('PromiseCache – batch fetcher populating cache via set()', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('batch fetcher that calls set() for all items — individual get() resolves correctly', async () => {
        type Item = { id: string; name: string };

        const allItems: Item[] = [
            { id: '1', name: 'Item 1' },
            { id: '2', name: 'Item 2' },
            { id: '3', name: 'Item 3' },
        ];

        const individualFetcher = vi.fn(async (id: string): Promise<Item> => {
            return delayedValue(50, allItems.find(i => i.id === id)!);
        });

        const cache = new PromiseCache<Item>(individualFetcher);

        const batchFetcher = vi.fn(async (ids: string[]): Promise<Item[]> => {
            await delayedValue(100, undefined);
            const results = ids.map(id => allItems.find(i => i.id === id)!);

            // The batch fetcher populates the cache for ALL items, not just the requested ones
            for (const item of allItems) {
                cache.set(item.id, item);
            }

            return results;
        });

        cache.extend(createBatchingExtension(batchFetcher, 20));

        // Request items 1 and 2 individually (they'll be batched together)
        const p1 = cache.get('1');
        const p2 = cache.get('2');

        await vi.advanceTimersByTimeAsync(200);

        expect(await p1).toEqual({ id: '1', name: 'Item 1' });
        expect(await p2).toEqual({ id: '2', name: 'Item 2' });

        // Item 3 was set by the batch fetcher — should be available immediately
        expect(await cache.get('3')).toEqual({ id: '3', name: 'Item 3' });

        expect(batchFetcher).toHaveBeenCalledTimes(1);
        expect(individualFetcher).not.toHaveBeenCalled();

        // Cache should not be stuck in loading state
        expect(cache.loadingCount).toBe(0);
        expect(cache.promisesCount).toBe(0);
    });

    test('set() during in-flight individual fetch does not leave item stuck in loading', async () => {
        type Item = { id: string; value: number };

        const individualFetcher = vi.fn(async (id: string): Promise<Item> => {
            return delayedValue(100, { id, value: 1 });
        });

        const cache = new PromiseCache<Item>(individualFetcher);

        // Start a fetch for item '1' (no batching — direct individual fetch)
        const p1 = cache.get('1');

        expect(cache.getIsLoading('1')).toBe(true);
        expect(cache.loadingCount).toBe(1);

        // Before the fetch completes, externally set the value
        await vi.advanceTimersByTimeAsync(30);
        cache.set('1', { id: '1', value: 42 });

        expect(cache.getCurrent('1', false)).toEqual({ id: '1', value: 42 });

        // Let the original fetch complete
        await vi.advanceTimersByTimeAsync(100);
        await p1;

        // Cache should be in a clean state
        expect(cache.loadingCount).toBe(0);
        expect(cache.getIsLoading('1')).not.toBe(true);
        expect(cache.promisesCount).toBe(0);
        expect(cache.getCurrent('1', false)).toBeDefined();
    });

    test('get() after set() from batch does not trigger a new fetch', async () => {
        type Item = { id: string };

        const individualFetcher = vi.fn(async (id: string): Promise<Item> => {
            return delayedValue(50, { id });
        });

        const cache = new PromiseCache<Item>(individualFetcher);

        const batchFetcher = vi.fn(async (ids: string[]): Promise<Item[]> => {
            await delayedValue(100, undefined);
            const results = ids.map(id => ({ id }));

            // Populate cache for extra items
            cache.set('extra-1', { id: 'extra-1' });
            cache.set('extra-2', { id: 'extra-2' });

            return results;
        });

        cache.extend(createBatchingExtension(batchFetcher, 20));

        const p1 = cache.get('1');
        await vi.advanceTimersByTimeAsync(200);
        await p1;

        // Now get the items that were set by the batch fetcher
        individualFetcher.mockClear();
        batchFetcher.mockClear();

        expect(await cache.get('extra-1')).toEqual({ id: 'extra-1' });
        expect(await cache.get('extra-2')).toEqual({ id: 'extra-2' });

        // No additional fetches should have been triggered
        expect(individualFetcher).not.toHaveBeenCalled();
        expect(batchFetcher).not.toHaveBeenCalled();
    });

    test('set() inside batch for in-flight keys — loading count stays consistent across multiple keys', async () => {
        const individualFetcher = vi.fn(async (id: string) => {
            return delayedValue(50, `individual-${id}`);
        });

        const cache = new PromiseCache<string>(individualFetcher);

        // Batch fetcher that calls set() for the same keys it's fetching
        const batchFetcher = vi.fn(async (ids: string[]) => {
            await delayedValue(80, undefined);

            for (const id of ids) {
                cache.set(id, `batch-${id}`);
            }

            return ids.map(id => `batch-${id}`);
        });

        cache.extend(createBatchingExtension(batchFetcher, 20));

        // Request multiple keys — all will be batched together
        const promises = ['a', 'b', 'c'].map(id => cache.get(id));

        expect(cache.loadingCount).toBe(3);
        expect(cache.promisesCount).toBe(3);

        await vi.advanceTimersByTimeAsync(200);
        const results = await Promise.all(promises);

        // All values should be resolved
        expect(results).toEqual(['batch-a', 'batch-b', 'batch-c']);

        // Cache must NOT be stuck in loading state — and count must not go negative
        expect(cache.loadingCount).toBe(0);
        expect(cache.promisesCount).toBe(0);
        expect(cache.getIsLoading('a')).toBe(false);

        // Subsequent get() should return cached values without new fetches
        individualFetcher.mockClear();
        batchFetcher.mockClear();

        expect(await cache.get('a')).toBe('batch-a');
        expect(individualFetcher).not.toHaveBeenCalled();
        expect(batchFetcher).not.toHaveBeenCalled();
    });

    test('getLazy() reflects correct state after batch set()', async () => {
        type Item = { id: string };

        const individualFetcher = vi.fn(async (id: string): Promise<Item> => {
            return delayedValue(50, { id });
        });

        const cache = new PromiseCache<Item>(individualFetcher);

        const batchFetcher = vi.fn(async (ids: string[]): Promise<Item[]> => {
            await delayedValue(80, undefined);
            const results = ids.map(id => ({ id }));

            cache.set('extra', { id: 'extra' });

            return results;
        });

        cache.extend(createBatchingExtension(batchFetcher, 20));

        const lazy1 = cache.getLazy('1');
        void lazy1.promise;

        expect(lazy1.isLoading).toBe(true);

        await vi.advanceTimersByTimeAsync(200);
        await lazy1.promise;

        expect(lazy1.isLoading).toBe(false);
        expect(lazy1.hasValue).toBe(true);
        expect(lazy1.value).toEqual({ id: '1' });

        // The 'extra' item set by batch should also be accessible
        const lazyExtra = cache.getLazy('extra');
        expect(lazyExtra.hasValue).toBe(true);
        expect(lazyExtra.value).toEqual({ id: 'extra' });
        expect(lazyExtra.isLoading).not.toBe(true);
    });
});

describe('PromiseCache – batch fetch failure reporting (onBatchError)', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('onBatchError fires once with the full batch key list, and both keys still resolve via per-key fallback', async () => {
        const individualFetcher = vi.fn(async (id: string): Promise<string> => {
            return delayedValue(10, `individual-${id}`);
        });

        const cache = new PromiseCache<string>(individualFetcher);

        const batchError = new Error('batch failed');
        const batchFetcher = vi.fn(async (_ids: string[]): Promise<string[]> => {
            return delayedError(20, batchError);
        });

        const onBatchError = vi.fn();

        cache.extend(createBatchingExtension(batchFetcher, 20, onBatchError));

        const p1 = cache.get('a');
        const p2 = cache.get('b');

        await vi.advanceTimersByTimeAsync(100);

        expect(await p1).toBe('individual-a');
        expect(await p2).toBe('individual-b');

        expect(batchFetcher).toHaveBeenCalledTimes(1);
        expect(onBatchError).toHaveBeenCalledTimes(1);
        expect(onBatchError).toHaveBeenCalledWith(['a', 'b'], batchError);
    });

    test('a throwing onBatchError does not prevent the per-key fallback', async () => {
        const individualFetcher = vi.fn(async (id: string): Promise<string> => {
            return delayedValue(10, `individual-${id}`);
        });

        const cache = new PromiseCache<string>(individualFetcher);

        const batchFetcher = vi.fn(async (_ids: string[]): Promise<string[]> => {
            return delayedError(20, new Error('batch failed'));
        });

        const onBatchError = vi.fn(() => {
            throw new Error('callback failed');
        });

        cache.extend(createBatchingExtension(batchFetcher, 20, onBatchError));

        const p1 = cache.get('a');

        await vi.advanceTimersByTimeAsync(100);

        expect(await p1).toBe('individual-a');
        expect(onBatchError).toHaveBeenCalledTimes(1);
    });
});
