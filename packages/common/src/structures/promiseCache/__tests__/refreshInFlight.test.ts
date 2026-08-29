import { LazyPromise } from '../../../lazy/promise.js';
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
});
