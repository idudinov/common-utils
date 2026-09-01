
import { PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';
import { describe, beforeEach, afterEach, test } from 'vitest';

describe('PromiseCache.refresh', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- Basic refresh ---
    test('basic refresh updates the cached value', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter));

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p1).toBe(1);

        const p2 = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p2).toBe(2);

        expect(cache.getCurrent('a', false)).toBe(2);
    });

    // --- Stale-while-revalidate ---
    test('stale value remains readable during refresh', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(50);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);

        // Start refresh — stale value should still be readable
        const refreshPromise = cache.refresh('a');

        // During refresh, stale value is still available
        expect(cache.getCurrent('a', false)).toBe(1);

        await vi.advanceTimersByTimeAsync(50);
        await refreshPromise;

        expect(cache.getCurrent('a', false)).toBe(2);
    });

    // --- Fetch running → refresh → initial fetch gets fresh value ---
    test('when existing fetch is running, refresh initiates new promise and initial fetch returns fresh value', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        // Start initial fetch
        const initialPromise = cache.get('a');

        // While initial fetch is in-flight, call refresh
        await vi.advanceTimersByTimeAsync(10);
        const refreshPromise = cache.refresh('a');

        // Advance past both fetches
        await vi.advanceTimersByTimeAsync(50);

        const [initialResult, refreshResult] = await Promise.all([initialPromise, refreshPromise]);

        // Both should resolve to the latest (2nd) value
        expect(refreshResult).toBe(2);
        expect(initialResult).toBe(2);
        expect(cache.getCurrent('a', false)).toBe(2);
        expect(counter).toBe(2);
    });

    // --- No value → refresh → get() joins existing refresh ---
    test('if there was no value, refresh initiates fetch, and get() joins existing refresh', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        // Call refresh on a key that has no value yet
        const refreshPromise = cache.refresh('a');

        // Now call get() — should join the existing refresh, not start a new fetch
        await vi.advanceTimersByTimeAsync(5);
        const getPromise = cache.get('a');

        await vi.advanceTimersByTimeAsync(50);

        const [refreshResult, getResult] = await Promise.all([refreshPromise, getPromise]);

        expect(refreshResult).toBe(1);
        expect(getResult).toBe(1);
        expect(counter).toBe(1); // only one fetch happened
    });

    // --- Subsequent refresh → both return same fresh value ---
    test('calling subsequent refresh initiates 2nd promise, both refreshes return the same fresh value', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        // Initial fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(50);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);

        // First refresh
        const refresh1 = cache.refresh('a');

        // Second refresh (supersedes the first)
        await vi.advanceTimersByTimeAsync(5);
        const refresh2 = cache.refresh('a');

        // Advance past both refreshes
        await vi.advanceTimersByTimeAsync(50);

        const [r1, r2] = await Promise.all([refresh1, refresh2]);

        // Both should resolve to the latest (3rd) value
        expect(r2).toBe(3);
        expect(r1).toBe(3);
        expect(cache.getCurrent('a', false)).toBe(3);
    });

    // --- Multiple concurrent refreshes with varying delays ---
    test('multiple concurrent refreshes - latest wins (fast-to-slow delays)', async () => {
        const delays = [100, 50, 20];
        let callIndex = 0;

        const cache = new PromiseCache<number>(async () => {
            const myIndex = callIndex++;
            const myDelay = delays[myIndex - 1] || 10;
            await new Promise(r => setTimeout(r, myDelay));
            return myIndex + 1;
        });

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(cache.getCurrent('a', false)).toBe(1);

        const refresh1 = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(5);
        const refresh2 = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(5);
        const refresh3 = cache.refresh('a');

        await vi.advanceTimersByTimeAsync(100);
        const [r1, r2, r3] = await Promise.all([refresh1, refresh2, refresh3]);

        expect(cache.getCurrent('a', false)).toBe(4);
        expect(r3).toBe(4);
        expect(r1).toBe(4);
        expect(r2).toBe(4);
    });

    test('multiple concurrent refreshes - latest wins (slow-to-fast delays)', async () => {
        const delays = [20, 50, 100];
        let callIndex = 0;

        const cache = new PromiseCache<number>(async () => {
            const myIndex = callIndex++;
            const myDelay = delays[myIndex - 1] || 10;
            await new Promise(r => setTimeout(r, myDelay));
            return myIndex + 1;
        });

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(20);
        await p;
        expect(cache.getCurrent('a', false)).toBe(1);

        const refresh1 = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(5);
        const refresh2 = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(5);
        const refresh3 = cache.refresh('a');

        await vi.advanceTimersByTimeAsync(100);
        const [r1, r2, r3] = await Promise.all([refresh1, refresh2, refresh3]);

        expect(cache.getCurrent('a', false)).toBe(4);
        expect(r3).toBe(4);
        expect(r1).toBe(4);
        expect(r2).toBe(4);
    });

    // --- getLazy().refresh() delegates to PromiseCache.refresh() ---
    test('getLazy().refresh() uses PromiseCache.refresh()', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter));

        const lazy = cache.getLazy('a');

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.value).toBe(1);

        // Stale value stays during refresh
        const refreshPromise = lazy.refresh();
        expect(lazy.currentValue).toBe(1); // stale value still available

        await vi.advanceTimersByTimeAsync(10);
        const refreshed = await refreshPromise;

        expect(refreshed).toBe(2);
        expect(lazy.value).toBe(2);
    });

    // --- Refreshing flag ---
    test('fetcher receives refreshing=false on initial get, refreshing=true on refresh', async () => {
        const fetcher = vi.fn(async (id: string, refreshing?: boolean) => {
            await new Promise(r => setTimeout(r, 10));
            return `${id}_${refreshing ? 'refreshed' : 'initial'}`;
        });
        const cache = new PromiseCache<string>(fetcher);

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        const v1 = await p1;

        expect(v1).toBe('a_initial');
        expect(fetcher).toHaveBeenCalledWith('a', false);
        fetcher.mockClear();

        const p2 = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(10);
        const v2 = await p2;

        expect(v2).toBe('a_refreshed');
        expect(fetcher).toHaveBeenCalledWith('a', true);
    });

    // --- get() during in-flight refresh with existing value ---
    test('get() during in-flight refresh returns stale value immediately (no new fetch)', async () => {
        let counter = 0;
        const fetcher = vi.fn(async () => delayedValue(50, ++counter));
        const cache = new PromiseCache<number>(fetcher);

        // Initial fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(50);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockClear();

        // Start refresh
        const refreshPromise = cache.refresh('a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockClear();

        // Call get() while refresh is in-flight — should return stale value, not start new fetch
        await vi.advanceTimersByTimeAsync(10);
        const getPromise = cache.get('a');

        // get() should NOT have triggered another fetch
        expect(fetcher).not.toHaveBeenCalled();

        // get() should resolve to the stale value (item is valid, not invalidated)
        const getResult = await getPromise;
        expect(getResult).toBe(1);

        // Finish the refresh
        await vi.advanceTimersByTimeAsync(50);
        const refreshResult = await refreshPromise;
        expect(refreshResult).toBe(2);
        expect(cache.getCurrent('a', false)).toBe(2);
    });

    // --- clear() during refresh ---
    test('clear() during refresh prevents stale result from being stored', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        // Initial fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(50);
        await p1;

        // Start refresh
        const refreshPromise = cache.refresh('a');

        // Clear while refresh is in-flight
        await vi.advanceTimersByTimeAsync(10);
        cache.clear();

        // Advance past the refresh
        await vi.advanceTimersByTimeAsync(50);
        await refreshPromise;

        // Cache should be empty — the refresh result should not have been stored
        expect(cache.getCurrent('a', false)).toBeUndefined();
        expect(cache.cachedCount).toBe(0);
    });

    // --- clear() race: pre-clear fetch settling late must not cancel the post-clear fetch ---
    test('pre-clear fetch settling late does not erase the post-clear fetch\'s result', async () => {
        const resolvers: ((value: number) => void)[] = [];
        const cache = new PromiseCache<number>(() => new Promise<number>(resolve => resolvers.push(resolve)));

        const p1 = cache.get('a');
        cache.clear();
        const p2 = cache.get('a');

        resolvers[0](111); // pre-clear fetch settles late
        await p1;

        resolvers[1](222); // post-clear fetch settles
        expect(await p2).toBe(222);

        expect(cache.getCurrent('a', false)).toBe(222);
        expect(cache.loadingCount).toBe(0);
    });

    // --- loadingCount correctness with superseded fetches ---
    test('loadingCount returns to 0 after concurrent refreshes complete', async () => {
        const cache = new PromiseCache<number>(async () => {
            await new Promise(r => setTimeout(r, 30));
            return 1;
        });

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(30);
        await p1;
        expect(cache.loadingCount).toBe(0);

        // 3 concurrent refreshes — each increments loadingCount
        const r1 = cache.refresh('a');
        const r2 = cache.refresh('a');
        const r3 = cache.refresh('a');

        expect(cache.loadingCount).toBe(3);

        await vi.advanceTimersByTimeAsync(30);
        await Promise.all([r1, r2, r3]);

        expect(cache.loadingCount).toBe(0);
    });

    test('loadingCount returns to 0 when superseded fetch errors', async () => {
        let callCount = 0;
        const cache = new PromiseCache<number>(async () => {
            callCount++;
            await new Promise(r => setTimeout(r, 30));
            if (callCount === 2) throw new Error('2nd fails');
            return callCount;
        });

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(30);
        await p1;
        expect(cache.loadingCount).toBe(0);

        // 1st refresh will succeed, 2nd will fail, 3rd will succeed
        const r1 = cache.refresh('a');
        const r2 = cache.refresh('a');
        const r3 = cache.refresh('a');

        expect(cache.loadingCount).toBe(3);

        await vi.advanceTimersByTimeAsync(30);
        await Promise.all([r1, r2, r3]);

        expect(cache.loadingCount).toBe(0);
    });

    // --- set() during in-flight fetch ---
    test('set() during in-flight fetch cancels the fetch (value is not overwritten)', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        const p = cache.get('a');

        // While fetch is in-flight, manually set a value
        await vi.advanceTimersByTimeAsync(10);
        cache.set('a', 999);
        expect(cache.getCurrent('a', false)).toBe(999);

        // Advance past the fetch
        await vi.advanceTimersByTimeAsync(50);
        await p;

        // The manually set value should NOT be overwritten by the in-flight fetch
        expect(cache.getCurrent('a', false)).toBe(999);
    });

    test('set() during in-flight refresh cancels the refresh (value is not overwritten)', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(50);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);

        const refreshPromise = cache.refresh('a');

        // While refresh is in-flight, manually set a value
        await vi.advanceTimersByTimeAsync(10);
        cache.set('a', 999);
        expect(cache.getCurrent('a', false)).toBe(999);

        // Advance past the refresh
        await vi.advanceTimersByTimeAsync(50);
        await refreshPromise;

        // The manually set value should NOT be overwritten by the in-flight refresh
        expect(cache.getCurrent('a', false)).toBe(999);
    });
});
