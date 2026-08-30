import { Disposer } from '@zajno/common/functions/disposer';
import { PromiseCacheObservable } from '../promiseCache.js';
import { autorun, reaction, runInAction, configure } from 'mobx';

describe('PromiseCache observable', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reacts on change', async () => {
        const cache = new PromiseCacheObservable(
            async (id: string) => id,
        );

        const handler = vi.fn();
        const checkHandler = (v: string | undefined) => {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(v);

            handler.mockClear();
        };

        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getCurrent('1', false),
                v => handler(v),
                { fireImmediately: true },
            ),
        );

        checkHandler(undefined);

        await expect(cache.getLazy('1').promise).resolves.toBe('1');

        checkHandler('1');

        cache.clear();

        checkHandler(undefined);

        cache.set('1', '2');

        checkHandler('2');

        disposer.dispose();
    });

    it('inner observable', async () => {
        const cache = new PromiseCacheObservable(
            async (id: string) => ({ id }),
        ).useObserveItems(true);

        const handler = vi.fn();
        const checkHandler = (res: any) => {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(res);

            handler.mockClear();
        };

        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getCurrent('1', false)?.id,
                v => handler(v),
                { fireImmediately: true },
            ),
        );

        checkHandler(undefined);

        await expect(cache.getLazy('1').promise).resolves.toStrictEqual({ id: '1' });

        checkHandler('1');

        const item = cache.getCurrent('1', false);
        expect(item).toBeDefined();

        runInAction(() => {
            item!.id = '2';
        });

        checkHandler('2');

        disposer.dispose();
    });

    it('handles invalidation by timeout', async () => {
        const fetcher = vi.fn(async (id: string) => {
            // Simulate async work with a 10ms delay
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return { id };
        });

        const cache = new PromiseCacheObservable(fetcher)
            .useInvalidation({ expirationMs: 10 })
            // .useLogger('test')
            ;

        const handler = vi.fn();
        const checkHandler = (res: any) => {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(res);

            handler.mockClear();
        };

        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getCurrent('1', false),
                v => handler(v?.id),
                { fireImmediately: true },
            ),
        );

        checkHandler(undefined);

        const lazy = cache.getLazy('1');

        // PASS 1 - initial fetch
        {
            // isLoading should be null when the item was never touched
            expect(lazy.isLoading).toBeNull();
            expect(lazy.value).toBeUndefined(); // triggers the fetch
            // here isLoading should be true since fetch is in progress
            expect(lazy.isLoading).toBe(true);

            // Advance past the 10ms fetcher delay
            await vi.advanceTimersByTimeAsync(10);

            expect(lazy.currentValue).toStrictEqual({ id: '1' });
            expect(lazy.isLoading).toBe(false);

            expect(fetcher).toHaveBeenCalledTimes(1);
            fetcher.mockClear();

            checkHandler('1');
        }

        // WAITING FOR INVALIDATION (advance past the 10ms invalidation threshold)
        await vi.advanceTimersByTimeAsync(20);

        // PASS 2 - re-fetch after invalidation
        {
            // settled entry stays false — passive expiry alone doesn't start a fetch
            expect(lazy.isLoading).toBe(false);
            // Stale value is always kept (stale-while-revalidate)
            expect(lazy.currentValue).toStrictEqual({ id: '1' });
            expect(lazy.value).toStrictEqual({ id: '1' }); // triggers a passive revalidation
            expect(lazy.pendingState).toBe('revalidating');
            // default strategy doesn't report a passive revalidation as loading
            expect(lazy.isLoading).toBe(false);

            // Advance past the 10ms fetcher delay
            await vi.advanceTimersByTimeAsync(10);

            expect(lazy.currentValue).toStrictEqual({ id: '1' });
            expect(lazy.isLoading).toBe(false);

            expect(fetcher).toHaveBeenCalledTimes(1);
            fetcher.mockClear();

            checkHandler('1');
        }

        disposer.dispose();
    });

    it('handles invalidation by timeout (stale-while-revalidate)', async () => {
        const fetcher = vi.fn(async (id: string) => ({ id }));

        const cache = new PromiseCacheObservable(fetcher)
            .useInvalidation({ expirationMs: 10 })
        ;

        const handler = vi.fn();
        const checkHandler = (res: any) => {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(res);

            handler.mockClear();
        };

        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getCurrent('1', false),
                v => handler(v?.id),
                { fireImmediately: true },
            ),
        );

        checkHandler(undefined);

        const lazy = cache.getLazy('1');

        // PASS 1 - initial fetch
        // isLoading should be null when the item was never touched
        expect(lazy.isLoading).toBeNull();
        expect(lazy.value).toBeUndefined(); // triggers the fetch
        // here isLoading should be true since fetch is in progress
        expect(lazy.isLoading).toBe(true);

        // Let the microtask-based fetcher resolve
        await vi.advanceTimersByTimeAsync(0);

        expect(lazy.currentValue).toStrictEqual({ id: '1' });
        expect(lazy.isLoading).toBe(false);

        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockClear();

        checkHandler('1');

        // WAITING FOR INVALIDATION (advance past the 10ms invalidation threshold)
        await vi.advanceTimersByTimeAsync(20);

        // PASS 2 - re-fetch after invalidation

        // settled entry stays false — passive expiry alone doesn't start a fetch
        expect(lazy.isLoading).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(0);

        expect(lazy.value).toStrictEqual({ id: '1' }); // returning old value, triggers a passive revalidation

        expect(handler).toHaveBeenCalledTimes(0); // no reaction

        expect(lazy.pendingState).toBe('revalidating');
        // default strategy doesn't report a passive revalidation as loading
        expect(lazy.isLoading).toBe(false);

        // Let the microtask-based fetcher resolve
        await vi.advanceTimersByTimeAsync(0);

        expect(lazy.currentValue).toStrictEqual({ id: '1' });
        expect(lazy.isLoading).toBe(false);

        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockClear();

        checkHandler('1');

        disposer.dispose();
    });

    // --- New tests for added functionality ---
    it('observable error tracking', async () => {
        const fetchError = new Error('Observable fetch error');

        const cache = new PromiseCacheObservable<string>(
            async (id) => {
                if (id === 'fail') throw fetchError;
                return id;
            },
        );

        const errorHandler = vi.fn();
        const disposer = new Disposer();

        disposer.add(
            reaction(
                () => cache.getLastError('fail'),
                v => errorHandler(v),
                { fireImmediately: true },
            ),
        );

        // Initially no error
        expect(errorHandler).toHaveBeenCalledTimes(1);
        expect(errorHandler).toHaveBeenCalledWith(null);
        errorHandler.mockClear();

        // Trigger fetch that will fail
        await cache.get('fail');

        // Error should be observable
        expect(errorHandler).toHaveBeenCalledTimes(1);
        expect(errorHandler).toHaveBeenCalledWith(fetchError);
        errorHandler.mockClear();

        // Clear should remove error
        cache.clear();
        expect(errorHandler).toHaveBeenCalledTimes(1);
        expect(errorHandler).toHaveBeenCalledWith(null);

        disposer.dispose();
    });

    it('observable counts', async () => {
        const cache = new PromiseCacheObservable<string>(
            async (id) => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return id;
            },
        );

        expect(cache.loadingCount).toBe(0);
        expect(cache.cachedCount).toBe(0);
        expect(cache.promisesCount).toBe(0);

        const loadingHandler = vi.fn();
        const disposer = new Disposer();

        disposer.add(
            reaction(
                () => cache.loadingCount,
                v => loadingHandler(v),
            ),
        );

        const p = cache.get('a');
        expect(cache.loadingCount).toBe(1);
        expect(cache.promisesCount).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(cache.loadingCount).toBe(0);
        expect(cache.cachedCount).toBe(1);
        expect(cache.promisesCount).toBe(0);

        // loadingHandler should have been called for 1 -> 0 transition
        expect(loadingHandler).toHaveBeenCalledWith(0);

        disposer.dispose();
    });

    it('sanitize works as action', async () => {
        const cache = new PromiseCacheObservable<string>(
            async (id) => id,
        ).useInvalidation({ expirationMs: 10 });

        await cache.get('a');
        await cache.get('b');

        expect(cache.cachedCount).toBe(2);

        await vi.advanceTimersByTimeAsync(20);

        expect(cache.invalidCount).toBe(2);

        const removed = cache.sanitize();
        expect(removed).toBe(2);
        expect(cache.cachedCount).toBe(0);
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

            cache.invalidate('a');

            stop();
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            configure({ enforceActions: 'never' });
        }
    });

    it('getLazy() error is observable', async () => {
        const fetchError = new Error('Deferred observable error');

        const cache = new PromiseCacheObservable<string>(
            async () => { throw fetchError; },
        );

        const lazy = cache.getLazy('fail');
        expect(lazy.error).toBeNull();

        await lazy.promise;
        expect(lazy.error).toBe(fetchError);
    });

    it('refresh triggers observable reactions', async () => {
        let counter = 0;
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return ++counter;
            },
        );

        const valueHandler = vi.fn();
        const disposer = new Disposer();

        // Initial fetch
        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);

        // Set up reaction on the cached value
        disposer.add(
            reaction(
                () => cache.getCurrent('a', false),
                v => valueHandler(v),
            ),
        );

        // Refresh — should trigger the reaction when the new value arrives
        const refreshPromise = cache.refresh('a');

        // Stale value still available during refresh
        expect(cache.getCurrent('a', false)).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;

        expect(cache.getCurrent('a', false)).toBe(2);
        expect(valueHandler).toHaveBeenCalledTimes(1);
        expect(valueHandler).toHaveBeenCalledWith(2);

        disposer.dispose();
    });

    it('getLazy().refresh() triggers observable reactions', async () => {
        let counter = 0;
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return ++counter;
            },
        );

        const lazy = cache.getLazy('a');

        // Initial fetch
        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.value).toBe(1);

        const valueHandler = vi.fn();
        const disposer = new Disposer();

        disposer.add(
            reaction(
                () => cache.getCurrent('a', false),
                v => valueHandler(v),
            ),
        );

        // Refresh via lazy handle
        const refreshPromise = lazy.refresh();
        expect(lazy.currentValue).toBe(1); // stale value

        await vi.advanceTimersByTimeAsync(10);
        const refreshed = await refreshPromise;

        expect(refreshed).toBe(2);
        expect(lazy.value).toBe(2);
        expect(valueHandler).toHaveBeenCalledTimes(1);
        expect(valueHandler).toHaveBeenCalledWith(2);

        disposer.dispose();
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

// --- Strict mode: every mutation, observed or not, must run inside an action ---
describe('PromiseCache observable — enforceActions: always', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        configure({ enforceActions: 'always' });
    });

    afterEach(() => {
        vi.useRealTimers();
        configure({ enforceActions: 'never' });
    });

    it('fetch round-trip, set(), invalidate(), clear(), and a useLoadingState swap warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));
        disposer.add(autorun(() => { void cache.getCurrent('a', false); }));

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);
        expect(cache.getCurrent('a', false)).toBe(1);

        cache.set('a', 2);
        expect(cache.getCurrent('a', false)).toBe(2);

        cache.invalidate('a');
        expect(cache.getCurrent('a', false)).toBeUndefined();

        cache.useLoadingState({ loading: false });

        cache.clear();

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('reaction on getIsLoading(key) fires across a fetch lifecycle', async () => {
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const handler = vi.fn();
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getIsLoading('a'),
                v => handler(v),
                { fireImmediately: true },
            ),
        );

        expect(handler).toHaveBeenCalledWith(null);

        const p = cache.get('a');
        expect(handler).toHaveBeenCalledWith(true);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(handler).toHaveBeenCalledWith(false);

        disposer.dispose();
    });

    it('reaction on getIsLoading re-fires when useLoadingState changes the strategy mid-flight', async () => {
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const handler = vi.fn();
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getIsLoading('a'),
                v => handler(v),
            ),
        );

        const p = cache.get('a');
        expect(cache.getIsLoading('a')).toBe(true);

        cache.useLoadingState({ loading: false });
        expect(cache.getIsLoading('a')).toBe(false);
        expect(handler).toHaveBeenCalledWith(false);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        disposer.dispose();
    });

    it('sanitize() and invalidate(key, \'silent\') run warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(async () => 1)
            .useInvalidation({ expirationMs: 5 });

        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));
        disposer.add(autorun(() => { void cache.getCurrent('a', false); }));

        await cache.get('a');
        await vi.advanceTimersByTimeAsync(10);

        expect(cache.sanitize()).toBe(1);

        await cache.get('b');
        cache.invalidate('b', 'silent');
        expect(cache.hasKey('b')).toBe(false);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('fetch success runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return 1;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('fetch error runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            throw new Error('fail');
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('refresh success runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let counter = 0;
        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return ++counter;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;

        const r = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await r).toBe(2);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('superseded refresh runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let counter = 0;
        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return ++counter;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;

        const r1 = cache.refresh('a');
        const r2 = cache.refresh('a'); // supersedes r1 before it settles
        await vi.advanceTimersByTimeAsync(10);
        await Promise.all([r1, r2]);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('cancelled fetch via set() mid-flight runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let resolveOriginal!: (v: number) => void;
        const cache = new PromiseCacheObservable<number>(
            () => new Promise<number>(resolve => { resolveOriginal = resolve; }),
        );
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p = cache.get('a');
        cache.set('a', 42);
        expect(cache.getCurrent('a', false)).toBe(42);

        resolveOriginal(999); // let the superseded original fetch settle and run its cleanup transaction
        await p;

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('reaction on getHasValue(key) + getIsLoading(key) together fires exactly once per semantic operation', async () => {
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const seen: { hasValue: boolean; isLoading: boolean | null }[] = [];
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => ({ hasValue: cache.getHasValue('a'), isLoading: cache.getIsLoading('a') }),
                v => seen.push(v),
            ),
        );

        const p = cache.get('a');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toStrictEqual({ hasValue: false, isLoading: true });

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(seen).toHaveLength(2);
        expect(seen[1]).toStrictEqual({ hasValue: true, isLoading: false });

        disposer.dispose();

        // set() on a never-touched key: hasValue/isLoading both transition together in one store
        const seenB: { hasValue: boolean; isLoading: boolean | null }[] = [];
        const disposerB = new Disposer();
        disposerB.add(
            reaction(
                () => ({ hasValue: cache.getHasValue('b'), isLoading: cache.getIsLoading('b') }),
                v => seenB.push(v),
            ),
        );

        cache.set('b', 2);

        expect(seenB).toHaveLength(1);
        expect(seenB[0]).toStrictEqual({ hasValue: true, isLoading: false });

        disposerB.dispose();
    });
});
