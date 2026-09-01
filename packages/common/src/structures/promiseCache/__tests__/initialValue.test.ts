
import { afterEach, beforeEach, describe, test } from 'vitest';
import { PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

describe('PromiseCache.useInitialValue', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- Static initial value ---
    test('getCurrent returns initial value before fetch', () => {
        const cache = new PromiseCache<string>(async (id) => delayedValue(10, `fetched-${id}`))
            .useInitialValue('loading...');

        expect(cache.getCurrent('a', false)).toBe('loading...');
    });

    test('get() resolves to fetched value (not initial)', async () => {
        const cache = new PromiseCache<string>(async (id) => delayedValue(10, `fetched-${id}`))
            .useInitialValue('loading...');

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe('fetched-a');
    });

    test('getCurrent returns fetched value after fetch completes', async () => {
        const cache = new PromiseCache<string>(async (id) => delayedValue(10, `fetched-${id}`))
            .useInitialValue('loading...');

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(cache.getCurrent('a', false)).toBe('fetched-a');
    });

    test('hasValue is false before fetch, true after', async () => {
        const cache = new PromiseCache<string>(async (id) => delayedValue(10, id))
            .useInitialValue('init');

        const lazy = cache.getLazy('a');
        expect(lazy.hasValue).toBe(false);

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(lazy.hasValue).toBe(true);
    });

    // --- Per-key factory ---
    test('per-key factory returns different initial values', () => {
        const cache = new PromiseCache<{ id: string; name: string }>(
            async (id) => delayedValue(10, { id, name: `User ${id}` }),
        ).useInitialValue((key) => ({ id: key, name: 'Loading...' }));

        expect(cache.getCurrent('a', false)).toEqual({ id: 'a', name: 'Loading...' });
        expect(cache.getCurrent('b', false)).toEqual({ id: 'b', name: 'Loading...' });
    });

    // --- Error fallback ---
    test('on error with no stale value, resolves to initial value', async () => {
        const cache = new PromiseCache<string>(async () => {
            await new Promise(r => setTimeout(r, 10));
            throw new Error('fetch failed');
        }).useInitialValue('fallback');

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        const result = await p;

        expect(result).toBe('fallback');
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
    });

    test('on error with stale value, resolves to stale value (not initial)', async () => {
        let shouldFail = false;
        const cache = new PromiseCache<string>(async (id) => {
            await new Promise(r => setTimeout(r, 10));
            if (shouldFail) throw new Error('refresh failed');
            return `fetched-${id}`;
        }).useInitialValue('fallback');

        // Initial successful fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(cache.getCurrent('a', false)).toBe('fetched-a');

        // Refresh that fails — should return stale value, not initial
        shouldFail = true;
        const p2 = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(10);
        const result = await p2;

        expect(result).toBe('fetched-a');
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
    });

    // --- getLazy() integration ---
    test('getLazy().value returns initial value before fetch', () => {
        const cache = new PromiseCache<string>(async (id) => delayedValue(10, id))
            .useInitialValue('init');

        const lazy = cache.getLazy('a');
        expect(lazy.value).toBe('init');
    });

    test('getLazy().currentValue returns initial value without triggering fetch', () => {
        const fetcher = vi.fn(async (id: string) => id);
        const cache = new PromiseCache<string>(fetcher)
            .useInitialValue('init');

        const lazy = cache.getLazy('a');
        expect(lazy.currentValue).toBe('init');
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('getLazy().promise resolves to fetched value', async () => {
        const cache = new PromiseCache<string>(async (id) => delayedValue(10, `fetched-${id}`))
            .useInitialValue('init');

        const lazy = cache.getLazy('a');
        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe('fetched-a');
    });

    test('getLazy().refresh() resolves to refreshed value', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter))
            .useInitialValue(0);

        const lazy = cache.getLazy('a');
        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(lazy.value).toBe(1);

        const rp = lazy.refresh();
        await vi.advanceTimersByTimeAsync(10);
        expect(await rp).toBe(2);
    });

    // --- Type narrowing ---
    test('without useInitialValue, getCurrent returns T | undefined', () => {
        const cache = new PromiseCache<string>(async (id) => id);

        // Type should be string | undefined
        const val: string | undefined = cache.getCurrent('a', false);
        expect(val).toBeUndefined();
    });

    test('with useInitialValue, getCurrent returns T (no undefined)', () => {
        const cache = new PromiseCache<string>(async (id) => id)
            .useInitialValue('default');

        // Type should be string (no undefined)
        const val: string = cache.getCurrent('a', false);
        expect(val).toBe('default');
    });

    // --- delete() resets to initial value ---
    test('after delete, getCurrent returns initial value', async () => {
        const cache = new PromiseCache<string>(async (id) => delayedValue(10, `fetched-${id}`))
            .useInitialValue('init');

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(cache.getCurrent('a', false)).toBe('fetched-a');

        cache.delete('a');
        expect(cache.getCurrent('a', false)).toBe('init');
    });
});

describe('PromiseCache delete cancels active fetches', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('delete during in-flight fetch prevents result from being stored', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        // Start fetch
        const p = cache.get('a');

        // Delete while fetch is in-flight
        await vi.advanceTimersByTimeAsync(10);
        cache.delete('a');

        // Advance past the fetch
        await vi.advanceTimersByTimeAsync(50);
        await p;

        // The fetch result should NOT have been stored (delete cancelled it)
        expect(cache.getCurrent('a', false)).toBeUndefined();
        expect(cache.cachedCount).toBe(0);
    });

    test('delete during in-flight refresh prevents result from being stored', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(50, ++counter));

        // Initial fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(50);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);

        // Start refresh
        const refreshPromise = cache.refresh('a');

        // Delete while refresh is in-flight
        await vi.advanceTimersByTimeAsync(10);
        cache.delete('a');

        // Advance past the refresh
        await vi.advanceTimersByTimeAsync(50);
        await refreshPromise;

        // The refresh result should NOT have been stored
        expect(cache.getCurrent('a', false)).toBeUndefined();
        expect(cache.cachedCount).toBe(0);
    });
});
