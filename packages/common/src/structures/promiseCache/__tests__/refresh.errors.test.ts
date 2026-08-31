
import { PromiseCache } from '../index.js';
import { describe, beforeEach, afterEach, test } from 'vitest';

describe('PromiseCache.refresh errors', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- Error handling: async throw ---
    test('async throw during refresh preserves stale value and stores error', async () => {
        let shouldFail = false;
        let counter = 0;
        const cache = new PromiseCache<number>(async () => {
            await new Promise(r => setTimeout(r, 10));
            counter++;
            if (shouldFail) throw new Error('refresh failed');
            return counter;
        });

        // Initial successful fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);
        expect(cache.getLastError('a')).toBeNull();

        // Refresh that fails
        shouldFail = true;
        const refreshPromise = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(10);
        const result = await refreshPromise;

        // Stale value preserved
        expect(result).toBe(1);
        expect(cache.getCurrent('a', false)).toBe(1);
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        // Recovery: successful refresh clears error
        shouldFail = false;
        const recoveryPromise = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(10);
        await recoveryPromise;

        expect(cache.getCurrent('a', false)).toBe(3);
        expect(cache.getLastError('a')).toBeNull();
    });

    test('async throw during initial fetch (no stale value) stores error', async () => {
        const cache = new PromiseCache<string>(async () => {
            await new Promise(r => setTimeout(r, 10));
            throw new Error('initial fetch failed');
        });

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(cache.getCurrent('a', false)).toBeUndefined();
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
    });

    // --- Error handling: sync throw ---
    test('sync throw in factory during initial fetch is handled', async () => {
        // Non-async factory: throw is truly synchronous (before any promise is created)
        const cache = new PromiseCache<string>(((() => {
            throw new Error('sync factory error');
        })));

        const p = cache.get('a');
        await p;

        expect(cache.getCurrent('a', false)).toBeUndefined();
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        expect((cache.getLastError('a') as Error).message).toBe('sync factory error');
    });

    test('sync throw in factory during refresh preserves stale value', async () => {
        let shouldFail = false;
        let counter = 0;
        // Non-async factory: when shouldFail is true, throw is truly synchronous
        const cache = new PromiseCache<number>(((() => {
            counter++;
            if (shouldFail) throw new Error('sync refresh error');
            return Promise.resolve(counter);
        })));

        // Initial successful fetch
        await cache.get('a');
        expect(cache.getCurrent('a', false)).toBe(1);

        // Refresh with sync throw
        shouldFail = true;
        const result = await cache.refresh('a');

        // Stale value preserved
        expect(result).toBe(1);
        expect(cache.getCurrent('a', false)).toBe(1);
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        expect((cache.getLastError('a') as Error).message).toBe('sync refresh error');
    });

    // --- Error during concurrent refresh ---
    test('error during 2nd refresh while 1st is in-flight', async () => {
        let callCount = 0;
        const cache = new PromiseCache<number>(async () => {
            callCount++;
            await new Promise(r => setTimeout(r, 30));
            if (callCount === 3) throw new Error('3rd call fails');
            return callCount;
        });

        // Initial fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(30);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);

        // 1st refresh (will succeed with value 2)
        const refresh1 = cache.refresh('a');

        // 2nd refresh (will fail — callCount will be 3)
        await vi.advanceTimersByTimeAsync(5);
        const refresh2 = cache.refresh('a');

        // Advance past both
        await vi.advanceTimersByTimeAsync(30);

        // refresh1 was superseded, should delegate to refresh2
        // refresh2 failed, so stale value (1) is preserved
        const r2 = await refresh2;
        const r1 = await refresh1;

        // The stale value from before the refreshes should be preserved
        expect(cache.getCurrent('a', false)).toBe(1);
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        // Both promises should resolve to the stale value
        expect(r2).toBe(1);
        expect(r1).toBe(1);
    });
});
