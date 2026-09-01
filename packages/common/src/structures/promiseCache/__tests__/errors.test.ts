
import { PromiseCache } from '../index.js';
import { describe, beforeEach, afterEach, test } from 'vitest';
import { delayedError, delayedValue } from './helpers.js';

describe('PromiseCache errors', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('error tracking', () => {
        test('stores and retrieves errors per key', async () => {
            const fetchError = new Error('Fetch failed');

            const cache = new PromiseCache<string>(
                async id => {
                    if (id === 'fail') throw fetchError;
                    return id;
                },
            );

            expect(cache.getLastError('fail')).toBeNull();

            await cache.get('fail');
            expect(cache.getLastError('fail')).toBe(fetchError);

            await cache.get('ok');
            expect(cache.getLastError('ok')).toBeNull();
        });

        test('getLazy exposes error', async () => {
            const fetchError = new Error('Lazy error');

            const cache = new PromiseCache<string>(
                async id => {
                    if (id === 'fail') throw fetchError;
                    return id;
                },
            );

            const lazy = cache.getLazy('fail');
            expect(lazy.error).toBeNull();

            await lazy.promise;
            expect(lazy.error).toBe(fetchError);
        });

        test('error is cleared on successful re-fetch', async () => {
            let shouldFail = true;

            const cache = new PromiseCache<string>(
                async id => {
                    if (shouldFail) throw new Error('fail');
                    return id;
                },
            );

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            // A failed fetch that never cached a value has no timestamp, so it never expires on its
            // own — the error is sticky until explicitly retried via refresh() or delete().
            shouldFail = false;
            await cache.refresh('a');

            expect(cache.getLastError('a')).toBeNull();
        });

        test('error is cleared on delete', async () => {
            const cache = new PromiseCache<string>(
                async () => { throw new Error('fail'); },
            );

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            cache.delete('a');
            expect(cache.getLastError('a')).toBeNull();
        });

        test('error is cleared on clear', async () => {
            const cache = new PromiseCache<string>(
                async () => { throw new Error('fail'); },
            );

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            cache.clear();
            expect(cache.getLastError('a')).toBeNull();
        });

        test('a slow fetch that fails after a concurrent refresh() already succeeded does not overwrite the newer state', async () => {
            const cache = new PromiseCache<number>(
                async (_id, refreshing) => refreshing
                    ? delayedValue(11, 42)
                    : delayedError(100, new Error('stale fetch failed')),
            );

            const p1 = cache.get('a');
            const p2 = cache.refresh('a');

            await vi.advanceTimersByTimeAsync(11);
            await p2;
            expect(cache.getCurrent('a', false)).toBe(42);
            expect(cache.getLastError('a')).toBeNull();

            await vi.advanceTimersByTimeAsync(89); // let the superseded fetch reject at t=100
            await p1;

            expect(cache.getLastError('a')).toBeNull();
            expect(cache.getCurrent('a', false)).toBe(42);
            expect(cache.getLazy('a').hasValue).toBe(true);
        });

        test('a late-settling superseded fetch does not erase a newer fetch\'s error', async () => {
            const resolvers: ((value: number) => void)[] = [];
            const rejectors: ((err: unknown) => void)[] = [];
            const cache = new PromiseCache<number>(() => new Promise<number>((resolve, reject) => {
                resolvers.push(resolve);
                rejectors.push(reject);
            }));

            const p1 = cache.get('a'); // F1 in flight
            const p2 = cache.refresh('a'); // F2 supersedes F1

            const error = new Error('F2 failed');
            rejectors[1](error);
            await p2;

            resolvers[0](111); // F1 settles late
            await p1;

            expect(cache.getLastError('a')).toBe(error);
            expect(cache.hasKey('a')).toBe(true);
            expect(cache.loadingCount).toBe(0);
        });

        test('clear resets all state including errors', async () => {
            const cache = new PromiseCache<string>(
                async () => { throw new Error('fail'); },
            );

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);
            expect(cache.loadingCount).toBe(0);

            cache.clear();

            expect(cache.getLastError('a')).toBeNull();
            expect(cache.cachedCount).toBe(0);
            expect(cache.promisesCount).toBe(0);
            expect(cache.loadingCount).toBe(0);
        });
    });

    describe('sticky error (no infinite re-fetch loop)', () => {
        test('get() after failure does NOT re-fetch — error is sticky', async () => {
            const fetcher = vi.fn(async () => {
                throw new Error('always fails');
            });

            const cache = new PromiseCache<string>(fetcher);

            // First get() — triggers fetch, which fails
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            fetcher.mockClear();

            // Second get() — should NOT trigger another fetch
            const result = await cache.get('a');
            expect(fetcher).not.toHaveBeenCalled();
            expect(result).toBeUndefined();
            expect(cache.getLastError('a')).toBeInstanceOf(Error);
        });

        test('getCurrent(key, true) after failure does NOT re-fetch', async () => {
            const fetcher = vi.fn(async () => {
                throw new Error('always fails');
            });

            const cache = new PromiseCache<string>(fetcher);

            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);
            fetcher.mockClear();

            // getCurrent with initiateFetch=true should NOT re-trigger
            cache.getCurrent('a', true);
            expect(fetcher).not.toHaveBeenCalled();
        });

        test('with useInitialValue, get() after failure returns initial value without re-fetching', async () => {
            const fetcher = vi.fn(async () => {
                throw new Error('always fails');
            });

            const cache = new PromiseCache<string>(fetcher)
                .useInitialValue('fallback');

            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);
            fetcher.mockClear();

            const result = await cache.get('a');
            expect(fetcher).not.toHaveBeenCalled();
            expect(result).toBe('fallback');
        });

        test('with expirationMs configured, a sticky first-fetch error survives the TTL — get() does not retry, refresh() does', async () => {
            const fetcher = vi.fn(async () => {
                throw new Error('always fails');
            });

            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 10 });

            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            // No value was ever stored, so there's no timestamp for the TTL to expire.
            await vi.advanceTimersByTimeAsync(20);

            fetcher.mockClear();
            await cache.get('a');
            expect(fetcher).not.toHaveBeenCalled();
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            await cache.refresh('a');
            expect(fetcher).toHaveBeenCalledTimes(1);
        });

        test('refresh() after sticky error DOES re-fetch', async () => {
            let callCount = 0;
            const cache = new PromiseCache<string>(async () => {
                callCount++;
                if (callCount === 1) throw new Error('first call fails');
                return 'success';
            });

            // First get() fails
            await cache.get('a');
            expect(callCount).toBe(1);
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            // refresh() should re-fetch even after sticky error
            const result = await cache.refresh('a');
            expect(callCount).toBe(2);
            expect(result).toBe('success');
            expect(cache.getLastError('a')).toBeNull();
        });

        test('delete() + get() after error DOES re-fetch', async () => {
            let callCount = 0;
            const cache = new PromiseCache<string>(async () => {
                callCount++;
                if (callCount === 1) throw new Error('first call fails');
                return 'success';
            });

            // First get() fails
            await cache.get('a');
            expect(callCount).toBe(1);
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            // delete() resets the error state
            cache.delete('a');
            expect(cache.getLastError('a')).toBeNull();

            // Now get() should re-fetch
            const result = await cache.get('a');
            expect(callCount).toBe(2);
            expect(result).toBe('success');
        });

        test('multiple get() calls on consistently failing fetcher — fetcher called only once', async () => {
            const fetcher = vi.fn(async () => {
                throw new Error('always fails');
            });

            const cache = new PromiseCache<string>(fetcher);

            // Call get() multiple times
            await cache.get('a');
            await cache.get('a');
            await cache.get('a');
            await cache.get('a');
            await cache.get('a');

            // Fetcher should have been called only once
            expect(fetcher).toHaveBeenCalledTimes(1);
        });

        test('getLazy().value after failure does NOT re-fetch', async () => {
            const fetcher = vi.fn(async () => {
                throw new Error('always fails');
            });

            const cache = new PromiseCache<string>(fetcher);

            const lazy = cache.getLazy('a');
            await lazy.promise;
            expect(fetcher).toHaveBeenCalledTimes(1);
            fetcher.mockClear();

            // Accessing .value should NOT trigger a new fetch
            void lazy.value;
            expect(fetcher).not.toHaveBeenCalled();
        });
    });

    describe('onError callback', () => {
        test('calls onError when fetcher fails', async () => {
            const fetchError = new Error('Fetch failed');
            const onError = vi.fn();

            const cache = new PromiseCache<string>(
                async () => { throw fetchError; },
            ).useOnError(onError);

            await cache.get('a');

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError).toHaveBeenCalledWith('a', fetchError);
        });

        test('does not call onError on success', async () => {
            const onError = vi.fn();

            const cache = new PromiseCache<string>(
                async id => id,
            ).useOnError(onError);

            await cache.get('a');
            expect(onError).not.toHaveBeenCalled();
        });

        test('ignores errors thrown by onError callback', async () => {
            const cache = new PromiseCache<string>(
                async () => { throw new Error('fetch error'); },
            ).useOnError(() => { throw new Error('callback error'); });

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);
        });

        test('can be removed with null', async () => {
            const onError = vi.fn();

            const cache = new PromiseCache<string>(
                async () => { throw new Error('fail'); },
            ).useOnError(onError);

            await cache.get('a');
            expect(onError).toHaveBeenCalledTimes(1);

            onError.mockClear();
            cache.useOnError(null);

            cache.delete('a');
            await cache.get('a');
            expect(onError).not.toHaveBeenCalled();
        });
    });
});
