import { LazyPromise } from '../../../lazy/promise.js';
import { ExpireTracker } from '../../expire.js';
import { PromiseCache } from '../index.js';

describe('PromiseCache refresh() during an in-flight get()', () => {

    test('keeps reporting loading until both fetches settle', async () => {
        const resolvers: ((v: number) => void)[] = [];
        const cache = new PromiseCache<number>(() => new Promise<number>(r => { resolvers.push(r); }));

        const p1 = cache.get('a');
        expect(cache.getIsLoading('a')).toBe(true);
        expect(cache.getLazy('a').pendingState).toBe('loading');

        const p2 = cache.refresh('a');
        expect(cache.getIsLoading('a')).toBe(true);
        expect(cache.getLazy('a').pendingState).toBe('loading');

        resolvers.forEach(r => r(42));
        await Promise.all([p1, p2]);

        expect(cache.getIsLoading('a')).toBe(false);
        expect(cache.getCurrent('a', false)).toBe(42);
    });

    test('parity: a standalone LazyPromise and a cache handle report the same pendingState/isLoading through get-then-refresh-mid-flight', async () => {
        const resolvers: ((v: number) => void)[] = [];
        const lazy = new LazyPromise(() => new Promise<number>(r => { resolvers.push(r); }));
        const cache = new PromiseCache<number>(() => new Promise<number>(r => { resolvers.push(r); }));

        const lazyPromise1 = lazy.promise;
        const cachePromise1 = cache.get('a');
        expect(lazy.pendingState).toBe(cache.getLazy('a').pendingState);
        expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);

        const lazyPromise2 = lazy.refresh();
        const cachePromise2 = cache.refresh('a');
        expect(lazy.pendingState).toBe(cache.getLazy('a').pendingState);
        expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);

        resolvers.forEach(r => r(42));
        await Promise.all([lazyPromise1, lazyPromise2, cachePromise1, cachePromise2]);

        expect(lazy.pendingState).toBe(cache.getLazy('a').pendingState);
        expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);
    });

    test('refresh() called during a revalidation escalates it to refreshing', async () => {
        let alwaysInvalid = false;
        const resolvers: ((v: number) => void)[] = [];
        const cache = new PromiseCache<number>(() => new Promise<number>(r => { resolvers.push(r); }))
            .useInvalidation({ invalidationCheck: () => alwaysInvalid });

        const p1 = cache.get('a');
        resolvers.shift()!(1);
        await p1;

        alwaysInvalid = true;
        const p2 = cache.get('a'); // stale value present + invalidated — passive revalidation
        expect(cache.getLazy('a').pendingState).toBe('revalidating');

        const loudLazy = cache.getLazy('a', { refreshing: true });
        expect(loudLazy.isLoading).toBe(false); // revalidating — not named by the handle strategy

        const p3 = cache.refresh('a'); // explicit refresh — stronger signal, escalates the classification
        expect(cache.getLazy('a').pendingState).toBe('refreshing');
        expect(loudLazy.isLoading).toBe(true);

        resolvers.forEach(r => r(2));
        await Promise.all([p2, p3]);
    });

    test('parity: get-then-expire-then-revalidate-then-refresh reports the same pendingState/isLoading on a standalone LazyPromise and a cache handle', async () => {
        vi.useFakeTimers();
        try {
            let lazyCounter = 0;
            let cacheCounter = 0;
            const expire = new ExpireTracker(10);
            const lazy = new LazyPromise(() => new Promise<number>(r => { setTimeout(() => r(++lazyCounter), 10); }))
                .withExpire(expire);
            const cache = new PromiseCache<number>(() => new Promise<number>(r => { setTimeout(() => r(++cacheCounter), 10); }))
                .useInvalidationTime(10);

            const lazyPromise1 = lazy.promise;
            const cachePromise1 = cache.get('a');
            expect(lazy.pendingState).toBe(cache.getLazy('a').pendingState);
            expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);

            await vi.advanceTimersByTimeAsync(10);
            await Promise.all([lazyPromise1, cachePromise1]);
            expect(lazy.pendingState).toBe(cache.getLazy('a').pendingState);
            expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);

            await vi.advanceTimersByTimeAsync(11); // expire both

            const lazyPromise2 = lazy.promise; // triggers revalidation
            const cachePromise2 = cache.get('a'); // triggers revalidation
            expect(lazy.pendingState).toBe('revalidating');
            expect(cache.getLazy('a').pendingState).toBe('revalidating');
            expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);

            const lazyPromise3 = lazy.refresh();
            const cachePromise3 = cache.refresh('a');
            expect(lazy.pendingState).toBe('refreshing');
            expect(cache.getLazy('a').pendingState).toBe('refreshing');
            expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);

            await vi.advanceTimersByTimeAsync(10);
            await Promise.all([lazyPromise2, lazyPromise3, cachePromise2, cachePromise3]);
            expect(lazy.pendingState).toBe(cache.getLazy('a').pendingState);
            expect(lazy.isLoading).toBe(cache.getLazy('a').isLoading);
        } finally {
            vi.useRealTimers();
        }
    });
});
