
import { PromiseCache } from '../index.js';
import { describe, beforeEach, afterEach, test } from 'vitest';

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

            const cache = new PromiseCache<string, string>(
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

            const cache = new PromiseCache<string, string>(
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

            const cache = new PromiseCache<string, string>(
                async id => {
                    if (shouldFail) throw new Error('fail');
                    return id;
                },
            ).useInvalidationTime(50);

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            shouldFail = false;
            await vi.advanceTimersByTimeAsync(60);

            await cache.get('a');
            expect(cache.getLastError('a')).toBeNull();
        });

        test('error is cleared on invalidate', async () => {
            const cache = new PromiseCache<string, string>(
                async () => { throw new Error('fail'); },
            );

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            cache.invalidate('a');
            expect(cache.getLastError('a')).toBeNull();
        });

        test('error is cleared on clear', async () => {
            const cache = new PromiseCache<string, string>(
                async () => { throw new Error('fail'); },
            );

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            cache.clear();
            expect(cache.getLastError('a')).toBeNull();
        });

        test('clear resets all state including errors', async () => {
            const cache = new PromiseCache<string, string>(
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

    describe('onError callback', () => {
        test('calls onError when fetcher fails', async () => {
            const fetchError = new Error('Fetch failed');
            const onError = vi.fn();

            const cache = new PromiseCache<string, string>(
                async () => { throw fetchError; },
            ).useOnError(onError);

            await cache.get('a');

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError).toHaveBeenCalledWith('a', fetchError);
        });

        test('does not call onError on success', async () => {
            const onError = vi.fn();

            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useOnError(onError);

            await cache.get('a');
            expect(onError).not.toHaveBeenCalled();
        });

        test('ignores errors thrown by onError callback', async () => {
            const cache = new PromiseCache<string, string>(
                async () => { throw new Error('fetch error'); },
            ).useOnError(() => { throw new Error('callback error'); });

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);
        });

        test('receives original key type for non-string keys', async () => {
            const onError = vi.fn();

            const cache = new PromiseCache<string, number>(
                async () => { throw new Error('fail'); },
                id => id.toString(),
                id => +id,
            ).useOnError(onError);

            await cache.get(42);

            expect(onError).toHaveBeenCalledWith(42, expect.any(Error));
        });

        test('can be removed with null', async () => {
            const onError = vi.fn();

            const cache = new PromiseCache<string, string>(
                async () => { throw new Error('fail'); },
            ).useOnError(onError);

            await cache.get('a');
            expect(onError).toHaveBeenCalledTimes(1);

            onError.mockClear();
            cache.useOnError(null);

            cache.invalidate('a');
            await cache.get('a');
            expect(onError).not.toHaveBeenCalled();
        });
    });
});
