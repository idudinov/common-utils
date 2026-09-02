
import { PromiseCache } from '../../structures/promiseCache/index.js';
import { ExpireTracker } from '../../structures/expire.js';
import { LazyPromise } from '../promise.js';

/** Helper: creates a promise that resolves after `ms` milliseconds (works with fake timers). */
function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

describe('LazyPromise', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- Deferred state write races under withAsyncStateChange ---

    test('revalidation resolving in the same microtask does not stick in "revalidating"', async () => {
        const expiredTracker = { isExpired: true, restart: vi.fn(), expire: vi.fn() };
        let calls = 0;
        const lazy = new LazyPromise(() => {
            calls++;
            return calls === 1 ? delay(10).then(() => 'first') : Promise.resolve('second');
        })
            .withAsyncStateChange(true)
            .withExpire(expiredTracker);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.currentValue).toBe('first');

        expect(lazy.value).toBe('first'); // stale value while the same-tick revalidation resolves
        await vi.advanceTimersByTimeAsync(0);

        expect(lazy.currentValue).toBe('second');
        expect(lazy.pendingState).toBeNull();
    });

    test('refresh() followed by a same-tick .value read does not downgrade "refreshing"', async () => {
        const expiredTracker = { isExpired: true, restart: vi.fn(), expire: vi.fn() };
        let resolveRefresh!: (value: string) => void;
        let calls = 0;
        const lazy = new LazyPromise(() => {
            calls++;
            return calls === 1
                ? delay(10).then(() => 'first')
                : new Promise<string>(resolve => { resolveRefresh = resolve; });
        })
            .withAsyncStateChange(true)
            .withExpire(expiredTracker)
            .withLoadingState({ refreshing: true });

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;

        const refreshPromise = lazy.refresh();
        expect(lazy.value).toBe('first'); // passive read in the same tick must not schedule a competing state write
        await vi.advanceTimersByTimeAsync(0);

        expect(lazy.pendingState).toBe('refreshing');
        expect(lazy.isLoading).toBeTrue();

        resolveRefresh('second');
        await refreshPromise;

        expect(lazy.currentValue).toBe('second');
        expect(lazy.pendingState).toBeNull();
    });

    // --- Error handling ---

    test('error handling with LazyPromise', async () => {
        {
            const l = new LazyPromise(async () => {
                throw new Error('async error message');
            });

            expect(l.error).toBeNull();
            await l.promise;
            expect(l.error).toBeInstanceOf(Error);
            expect((l.error as Error).message).toBe('async error message');
            expect(l.hasValue).toBeFalse();
            expect(l.value).toBeUndefined();
        }

        {
            const l = new LazyPromise(async () => {
                throw new Error('async Error object');
            });

            await l.promise;
            expect(l.error).toBeInstanceOf(Error);
            expect((l.error as Error).message).toBe('async Error object');
        }

        {
            const l = new LazyPromise<string, string>(async () => {
                throw new Error('error occurred');
            }, 'initial value');

            expect(l.value).toBe('initial value');
            await l.promise;
            expect(l.error).toBeInstanceOf(Error);
            expect((l.error as Error).message).toBe('error occurred');
            expect(l.value).toBe('initial value');
        }
    });

    test('reset during in-flight factory rejection does not corrupt state', async () => {
        let rejectFn: (err: Error) => void;
        const lazy = new LazyPromise<string>(() => {
            return new Promise<string>((_resolve, reject) => {
                rejectFn = reject;
            });
        });

        // Start loading
        const p = lazy.promise;
        expect(lazy.isLoading).toBeTrue();

        // Reset while factory is still in-flight
        lazy.reset();
        expect(lazy.isLoading).toBeNull();
        expect(lazy.error).toBeNull();

        // Now the factory rejects — should NOT corrupt the reset state
        rejectFn!(new Error('late rejection'));
        await p.catch(() => { /* swallow */ });

        // Allow microtasks to settle
        await vi.advanceTimersByTimeAsync(0);

        // State should still be clean after reset
        expect(lazy.isLoading).toBeNull();
        expect(lazy.error).toBeNull();
        expect(lazy.hasValue).toBeFalse();
    });

    // --- hasResolvedValue type narrowing ---

    test('hasResolvedValue narrows type after successful load', async () => {
        const lazy = new LazyPromise(async () => {
            await delay(10);
            return { name: 'Alice' };
        });

        expect(lazy.hasResolvedValue()).toBe(false);

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(lazy.hasResolvedValue()).toBe(true);

        if (lazy.hasResolvedValue()) {
            // Type narrowing: value is { name: string }, not { name: string } | undefined
            const name: string = lazy.value.name;
            expect(name).toBe('Alice');

            const current: { name: string } = lazy.currentValue;
            expect(current.name).toBe('Alice');
        }
    });

    test('hasResolvedValue returns false after error', async () => {
        const lazy = new LazyPromise(async () => {
            throw new Error('fail');
        });

        await lazy.promise;

        expect(lazy.hasResolvedValue()).toBe(false);
        expect(lazy.hasValue).toBe(false);
        expect(lazy.error).toBeInstanceOf(Error);
    });

    test('hasResolvedValue returns false before load', () => {
        const lazy = new LazyPromise(async () => 42);
        expect(lazy.hasResolvedValue()).toBe(false);
    });

    // --- Granular state: hasValue decoupled from isLoading ---

    describe('hasValue during pending states', () => {

        test('stays true during passive revalidation of an expired value', async () => {
            const expire = new ExpireTracker(10);
            let counter = 0;
            const lazy = new LazyPromise(() => delay(10).then(() => ++counter)).withExpire(expire);

            const p1 = lazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p1;
            expect(lazy.hasValue).toBeTrue();

            await vi.advanceTimersByTimeAsync(11);
            expect(expire.isExpired).toBeTrue();

            expect(lazy.value).toBe(1); // starts a passive revalidation
            expect(lazy.isLoading).toBeFalse(); // default strategy: revalidating doesn't report loading
            expect(lazy.hasValue).toBeTrue(); // yet the stale value is still considered available

            const p2 = lazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p2;
            expect(lazy.hasValue).toBeTrue();
        });

        test('stays true during refresh() regardless of the loading-state strategy', async () => {
            let counter = 0;
            const lazy = new LazyPromise(() => delay(10).then(() => ++counter));

            const p1 = lazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p1;
            expect(lazy.hasValue).toBeTrue();

            const refreshPromise = lazy.refresh();
            expect(lazy.hasValue).toBeTrue(); // default strategy hides the refresh, hasValue stays true regardless

            await vi.advanceTimersByTimeAsync(10);
            await refreshPromise;
            expect(lazy.hasValue).toBeTrue();

            const loudLazy = new LazyPromise(() => delay(10).then(() => ++counter))
                .withLoadingState({ refreshing: true });
            const loudPromise = loudLazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await loudPromise;

            const loudRefresh = loudLazy.refresh();
            expect(loudLazy.isLoading).toBeTrue();
            expect(loudLazy.hasValue).toBeTrue(); // still true, even though isLoading now reports true

            await vi.advanceTimersByTimeAsync(10);
            await loudRefresh;
            expect(loudLazy.hasValue).toBeTrue();
        });

        test('flips to false after reset()', async () => {
            const lazy = new LazyPromise(() => delay(10).then(() => 'value'));
            const p = lazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p;
            expect(lazy.hasValue).toBeTrue();

            lazy.reset();
            expect(lazy.hasValue).toBeFalse();
        });

        test('stays false while an error is set, even with a stale value present', async () => {
            let shouldFail = false;
            const lazy = new LazyPromise(() => delay(10).then(() => {
                if (shouldFail) {
                    throw new Error('fail');
                }
                return 'value';
            }));

            const p = lazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p;
            expect(lazy.hasValue).toBeTrue();

            shouldFail = true;
            const refreshPromise = lazy.refresh();
            await vi.advanceTimersByTimeAsync(10);
            await refreshPromise;
            expect(lazy.error).toBeInstanceOf(Error);
            expect(lazy.hasValue).toBeFalse();
        });

        test('parity: LazyPromise and PromiseCache.getLazy() report the same hasValue/isLoading during passive revalidation', async () => {
            const expire = new ExpireTracker(10);
            let lazyCounter = 0;
            const lazy = new LazyPromise(() => delay(10).then(() => ++lazyCounter)).withExpire(expire);

            let cacheCounter = 0;
            const cache = new PromiseCache<number>(async () => {
                await delay(10);
                return ++cacheCounter;
            }).useInvalidation({ expirationMs: 10 });
            const cacheLazy = cache.getLazy('a');

            const p1 = lazy.promise;
            const p2 = cacheLazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p1;
            await p2;
            expect(lazy.hasValue).toBe(cacheLazy.hasValue);
            expect(lazy.isLoading).toBe(cacheLazy.isLoading);

            await vi.advanceTimersByTimeAsync(11);

            expect(lazy.value).toBe(1); // starts a passive revalidation
            expect(cacheLazy.value).toBe(1);
            expect(lazy.hasValue).toBe(cacheLazy.hasValue);
            expect(lazy.hasValue).toBeTrue();
            expect(lazy.isLoading).toBe(cacheLazy.isLoading);
            expect(lazy.isLoading).toBeFalse();

            const p3 = lazy.promise;
            const p4 = cacheLazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p3;
            await p4;
            expect(lazy.hasValue).toBe(cacheLazy.hasValue);
            expect(lazy.isLoading).toBe(cacheLazy.isLoading);
        });

        test('parity under { revalidating: false }: LazyPromise and PromiseCache.getLazy() silence isLoading identically during passive revalidation', async () => {
            const expire = new ExpireTracker(10);
            let lazyCounter = 0;
            const lazy = new LazyPromise(() => delay(10).then(() => ++lazyCounter))
                .withExpire(expire)
                .withLoadingState({ revalidating: false });

            let cacheCounter = 0;
            const cache = new PromiseCache<number>(async () => {
                await delay(10);
                return ++cacheCounter;
            }).useInvalidation({ expirationMs: 10 }).useLoadingState({ revalidating: false });
            const cacheLazy = cache.getLazy('a');

            const p1 = lazy.promise;
            const p2 = cacheLazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p1;
            await p2;
            expect(lazy.hasValue).toBe(cacheLazy.hasValue);
            expect(lazy.isLoading).toBe(cacheLazy.isLoading);
            expect(lazy.isLoading).toBeFalse();

            await vi.advanceTimersByTimeAsync(11);

            expect(lazy.value).toBe(1); // starts a silent passive revalidation
            expect(cacheLazy.value).toBe(1);
            expect(lazy.hasValue).toBe(cacheLazy.hasValue);
            expect(lazy.hasValue).toBeTrue();
            expect(lazy.isLoading).toBe(cacheLazy.isLoading);
            expect(lazy.isLoading).toBeFalse(); // silenced on both sides

            const p3 = lazy.promise;
            const p4 = cacheLazy.promise;
            await vi.advanceTimersByTimeAsync(10);
            await p3;
            await p4;
            expect(lazy.hasValue).toBe(cacheLazy.hasValue);
            expect(lazy.isLoading).toBe(cacheLazy.isLoading);
        });
    });

});
