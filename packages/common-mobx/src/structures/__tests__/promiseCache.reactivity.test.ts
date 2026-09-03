import { Disposer } from '@zajno/common/functions/disposer';
import { autorun, configure, reaction } from 'mobx';
import { PromiseCacheObservable } from '../promiseCache.js';

describe('PromiseCache observable', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('set()/invalidate() are actions — mutating the observed _fetchCache while a fetch is in flight does not warn under enforceActions', async () => {
        configure({ enforceActions: 'observed' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const cache = new PromiseCacheObservable<number>(
                () => new Promise<number>(() => { /* never settles */ }),
            );

            const stop = autorun(() => { void cache.promisesCount; });

            cache.get('a'); // starts an in-flight fetch, tracked via promisesCount

            cache.set('a', 42);
            expect(cache.getCurrent('a', false)).toBe(42);
            expect(cache.promisesCount).toBe(0);

            cache.delete('a');

            stop();
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            configure({ enforceActions: 'never' });
        }
    });

    // --- Sticky error: no infinite re-fetch loop ---
    it('reaction on getCurrent does NOT cause infinite fetch loop on error', async () => {
        // Enforce actions to catch unprotected observable mutations
        configure({ enforceActions: 'observed' });

        const fetcher = vi.fn(async () => {
            throw new Error('always fails');
        });

        const cache = new PromiseCacheObservable<string>(fetcher);

        // First: verify that get() after error doesn't re-fetch (non-reactive)
        await cache.get('a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        // Second get() should NOT re-fetch
        await cache.get('a');
        expect(fetcher).toHaveBeenCalledTimes(1);

        // Now test with reaction
        fetcher.mockClear();
        cache.clear(); // reset state

        const valueHandler = vi.fn();
        const disposer = new Disposer();

        disposer.add(
            reaction(
                () => cache.getCurrent('a', false), // read without triggering fetch
                v => valueHandler(v),
                { fireImmediately: true },
            ),
        );

        // Manually trigger fetch
        await cache.get('a');

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        // Subsequent get() should NOT re-fetch
        await cache.get('a');
        expect(fetcher).toHaveBeenCalledTimes(1);

        disposer.dispose();
        configure({ enforceActions: 'never' });
    });

    it('reaction on getLazy().value does NOT cause infinite fetch loop on error', async () => {
        const fetcher = vi.fn(async () => {
            throw new Error('always fails');
        });

        const cache = new PromiseCacheObservable<string>(fetcher);
        const lazy = cache.getLazy('a');

        // First: verify non-reactive behavior
        await lazy.promise;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(lazy.error).toBeInstanceOf(Error);

        // Accessing value should NOT re-trigger fetch
        void lazy.value;
        expect(fetcher).toHaveBeenCalledTimes(1);

        // Now test with reaction on currentValue (read-only, no fetch trigger)
        fetcher.mockClear();
        cache.clear();

        const valueHandler = vi.fn();
        const disposer = new Disposer();

        disposer.add(
            reaction(
                () => lazy.currentValue,
                v => valueHandler(v),
                { fireImmediately: true },
            ),
        );

        // Manually trigger fetch
        await cache.get('a');

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(lazy.error).toBeInstanceOf(Error);

        // Subsequent get() should NOT re-fetch
        await cache.get('a');
        expect(fetcher).toHaveBeenCalledTimes(1);

        disposer.dispose();
    });

    it('after sticky error, refresh() still works in observable context', async () => {
        let callCount = 0;
        const fetcher = vi.fn(async () => {
            callCount++;
            if (callCount === 1) throw new Error('first call fails');
            return `success-${callCount}`;
        });

        const cache = new PromiseCacheObservable<string>(fetcher);

        const valueHandler = vi.fn();
        const disposer = new Disposer();

        // Initial fetch fails
        await cache.get('a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        // Set up reaction
        disposer.add(
            reaction(
                () => cache.getCurrent('a', false),
                v => valueHandler(v),
            ),
        );

        // refresh() should work and trigger the reaction
        const result = await cache.refresh('a');
        expect(result).toBe('success-2');
        expect(cache.getLastError('a')).toBeNull();
        expect(valueHandler).toHaveBeenCalledWith('success-2');

        disposer.dispose();
    });

    // --- Loading state strategy reactivity ---
    it('observer on getIsLoading()/getLazy().isLoading reacts across transitions with a strategy set', async () => {
        let counter = 0;
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return ++counter;
            },
        ).useLoadingState({ refreshing: true });

        const lazy = cache.getLazy('a');

        const isLoadingHandler = vi.fn();
        const lazyIsLoadingHandler = vi.fn();
        const disposer = new Disposer();

        disposer.add(
            reaction(
                () => cache.getIsLoading('a'),
                v => isLoadingHandler(v),
            ),
        );
        disposer.add(
            reaction(
                () => lazy.isLoading,
                v => lazyIsLoadingHandler(v),
            ),
        );

        // Initial fetch: undefined -> true -> false
        const p1 = cache.get('a');
        expect(cache.getIsLoading('a')).toBe(true);
        await vi.advanceTimersByTimeAsync(10);
        await p1;

        expect(isLoadingHandler).toHaveBeenCalledWith(true);
        expect(isLoadingHandler).toHaveBeenCalledWith(false);
        expect(lazyIsLoadingHandler).toHaveBeenCalledWith(true);
        expect(lazyIsLoadingHandler).toHaveBeenCalledWith(false);

        isLoadingHandler.mockClear();
        lazyIsLoadingHandler.mockClear();

        // Refresh: strategy reports isLoading true during flight (overridden from the default false)
        const refreshPromise = cache.refresh('a');
        expect(cache.getIsLoading('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;

        expect(isLoadingHandler).toHaveBeenCalledWith(true);
        expect(isLoadingHandler).toHaveBeenCalledWith(false);
        expect(lazyIsLoadingHandler).toHaveBeenCalledWith(true);
        expect(lazyIsLoadingHandler).toHaveBeenCalledWith(false);

        disposer.dispose();
    });

    it('useLoadingState() called mid-flight is observed by autorun on getLazy().isLoading', async () => {
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const seen: (boolean | null)[] = [];
        const clean = autorun(() => { seen.push(cache.getLazy('a').isLoading); });

        const p = cache.get('a');
        expect(cache.getLazy('a').isLoading).toBe(true);

        cache.useLoadingState({ loading: false });

        expect(cache.getLazy('a').isLoading).toBe(false);
        expect(seen.at(-1)).toBe(false);

        clean();

        await vi.advanceTimersByTimeAsync(10);
        await p;
    });
});
