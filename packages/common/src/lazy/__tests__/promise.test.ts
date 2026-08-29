
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

    test('simple', async () => {
        const VAL = 'abc';
        const l = new LazyPromise(() => delay(100).then(() => VAL));

        expect(l.hasValue).toBeFalse();
        expect(l.currentValue).toBeUndefined();
        expect(l.isLoading).toBeNull();

        expect(l.value).toBeUndefined();
        expect(l.isLoading).toBeTrue();

        const p = l.promise;
        await vi.advanceTimersByTimeAsync(100);
        await expect(p).resolves.not.toThrow();

        expect(l.hasValue).toBeTrue();
        expect(l.isLoading).toBeFalse();
        expect(l.value).toBe(VAL);
        expect(l.currentValue).toBe(VAL);

        l.dispose();
        expect(l.hasValue).toBeFalse();
    });

    test('setInstance', async () => {
        const VAL = 'abc1';
        const factory = vi.fn(() => delay(10).then(() => VAL));
        const l = new LazyPromise(factory);

        expect(l.hasValue).toBeFalse();
        expect(l.isLoading).toBeNull();

        expect(l.value).toBeUndefined();
        expect(l.isLoading).toBeTrue();

        const p = l.promise;

        const VAL2 = 'abc2';
        l.setInstance(VAL2);

        // Advance timer so the original factory promise resolves (abandoned, returns setInstance value)
        await vi.advanceTimersByTimeAsync(10);

        await expect(p).resolves.toBe(VAL2);
        await expect(l.promise).resolves.toBe(VAL2);

        const VAL3 = 'abc3';
        l.setInstance(VAL3);
        await expect(l.promise).resolves.toBe(VAL3);
    });

    test('with expire', async () => {
        let incrementor = 0;

        const expire = new ExpireTracker(10);

        const l = new LazyPromise(() => delay(10).then(() => ++incrementor))
            .withExpire(expire);

        expect(l.hasValue).toBeFalse();
        expect(l.isLoading).toBeFalsy();

        expect(l.value).toBeUndefined();
        expect(l.isLoading).toBeTrue();

        const next = incrementor + 1;
        const p1 = l.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p1).resolves.toBe(next);
        expect(incrementor).toBe(next);

        expect(l.hasValue).toBeTrue();
        expect(l.isLoading).toBeFalse();
        expect(l.value).toBe(1);
        expect(expire.isExpired).toBeFalse();
        expect(expire.remainingMs).toBeLessThanOrEqual(10);

        await vi.advanceTimersByTimeAsync(11);

        expect(expire.isExpired).toBeTrue();
        expect(l.hasValue).toBeTrue();
        expect(l.value).toBe(1);

        const p2 = l.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p2).resolves.toBe(2);
        expect(incrementor).toBe(2);
        expect(expire.isExpired).toBeFalse();

        expire.expire();
        expect(expire.isExpired).toBeTrue();
        expect(l.hasValue).toBeTrue();
        expect(l.value).toBe(2);
        const p3 = l.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p3).resolves.toBe(3);
        expect(incrementor).toBe(3);
        expect(expire.isExpired).toBeFalse();
        expect(l.value).toBe(3);
    });

    test('disposes', async () => {
        const disposer = vi.fn();

        const l = new LazyPromise(async () => ({
            value: 42,
            dispose() {
                disposer();
            },
        }));

        await l.promise;

        expect(l.value).toBeDefined();
        expect(l.value?.value).toBe(42);
        expect(l.hasValue).toBeTrue();

        l.dispose();
        expect(l.hasValue).toBeFalse();
        expect(disposer).toHaveBeenCalledTimes(1);
    });

    test('with initial value', async () => {
        const lazy = new LazyPromise(async () => {
            await delay(10);
            return { result: 42 };
        }, { result: 10 });

        expect(lazy.hasValue).toBeFalse();
        expect(lazy.isLoading).toBeNull();

        expect(lazy.value.result).toBe(10);
        expect(lazy.isLoading).toBeTrue();

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p).resolves.toEqual({ result: 42 });

        expect(lazy.value.result).toBe(42);
        expect(lazy.hasValue).toBeTrue();
        expect(lazy.isLoading).toBeFalse();
    });

    test('with no initial value', async () => {
        const lazy = new LazyPromise(async () => {
            await delay(10);
            return { result: 42 };
        });

        expect(lazy.hasValue).toBeFalse();
        expect(lazy.isLoading).toBeNull();
        expect(lazy.currentValue).toBeUndefined();

        expect(lazy.value).toBeUndefined();
        expect(() => {
            // @ts-expect-error Type is `T | undefined` — accessing `.result` on a possibly-undefined value is a type error
            return lazy.value.result;
        }).toThrow();

        expect(lazy.isLoading).toBeTrue();

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p).resolves.toEqual({ result: 42 });

        // @ts-expect-error Type is still `T | undefined` (no initial value), so `.result` access is a type error even though value is loaded
        expect(lazy.value.result).toBe(42);
        expect(lazy.hasValue).toBeTrue();
        expect(lazy.isLoading).toBeFalse();
    });

    test('async state change', async () => {
        const lazy = new LazyPromise(async () => {
            await delay(10);
            return { result: 42 };
        }).withAsyncStateChange(true);

        expect(lazy.hasValue).toBeFalse();
        expect(lazy.isLoading).toBeNull();
        expect(lazy.currentValue).toBeUndefined();

        expect(lazy.value).toBeUndefined();
        expect(lazy.isLoading).toBeNull();

        await vi.advanceTimersByTimeAsync(0);
        expect(lazy.isLoading).toBeTrue();

        await vi.advanceTimersByTimeAsync(11);
        await expect(lazy.promise).resolves.toEqual({ result: 42 });
        expect(lazy.isLoading).toBeFalse();
        expect(lazy.hasValue).toBeTrue();
        expect(lazy.value!.result).toBe(42);
    });

    // ─── Error handling ─────────────────────────────────────────────────

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

    // ─── hasResolvedValue type narrowing ─────────────────────────────────

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

    // ─── Granular state: hasValue decoupled from isLoading ────────────────

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
            }).useInvalidationTime(10);
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
            }).useInvalidationTime(10).useLoadingState({ revalidating: false });
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
