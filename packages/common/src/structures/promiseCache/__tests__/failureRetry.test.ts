
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { PromiseCache } from '../index.js';

/** A fetcher that rejects while `state.fail` is set; resolves to `value-<call number>` otherwise. */
function createFetcher(fail = true) {
    const state = { fail, calls: 0 };
    const fetcher = vi.fn(async () => {
        state.calls++;
        if (state.fail) {
            throw new Error('fail');
        }
        return `value-${state.calls}`;
    });
    return { state, fetcher };
}

describe('PromiseCache failure retry pacing', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('failureRetryMs', () => {
        test('0 retries on every read, also while expirationMs would wait', async () => {
            const { state, fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 1000, failureRetryMs: 0 });

            await cache.get('a');
            await cache.get('a');
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(3);

            state.fail = false;
            await cache.get('a');
            expect(cache.getLastError('a')).toBeNull();
            expect(cache.getCurrent('a', false)).toBe('value-4');
        });

        test('0 retries a failed revalidation of an expired value on every read, serving the stale value', async () => {
            const { state, fetcher } = createFetcher(false);
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 100, failureRetryMs: 0 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(101);

            state.fail = true;
            expect(await cache.get('a')).toBe('value-1');
            expect(await cache.get('a')).toBe('value-1');
            expect(await cache.get('a')).toBe('value-1');
            expect(fetcher).toHaveBeenCalledTimes(4);
        });

        test('Infinity never retries on a read, however long ago the first fetch failed', async () => {
            const { fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 10, failureRetryMs: Infinity });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(1000);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);
        });

        test('Infinity never retries a failed revalidation of an expired value on a read', async () => {
            const { state, fetcher } = createFetcher(false);
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 10, failureRetryMs: Infinity });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(11);

            state.fail = true;
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(1000);
            expect(await cache.get('a')).toBe('value-1');
            expect(fetcher).toHaveBeenCalledTimes(2);
        });

        test('a number paces retries with no expirationMs configured', async () => {
            const { state, fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ failureRetryMs: 50 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(49);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(2);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            // the second failure restarts the wait
            await vi.advanceTimersByTimeAsync(49);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            state.fail = false;
            await vi.advanceTimersByTimeAsync(2);
            expect(await cache.get('a')).toBe('value-3');
            expect(cache.getLastError('a')).toBeNull();
        });

        test('a number replaces the lifetime as the wait, for a failed first fetch and a failed revalidation', async () => {
            const { state, fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 1000, failureRetryMs: 10 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(11);
            state.fail = false;
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(1001);
            state.fail = true;
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(3);

            await vi.advanceTimersByTimeAsync(9);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(3);

            await vi.advanceTimersByTimeAsync(2);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(4);
        });

        test('null falls back to expirationMs', async () => {
            const { fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 10, failureRetryMs: null });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(9);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(2);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);
        });

        test('a non-positive expirationMs applies no wait, so a failed first fetch waits for an explicit call', async () => {
            const { fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 0 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(1000);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);
        });

        test('with only invalidationCheck, a rejected value\'s failed refresh is retried on every read, and failureRetryMs paces it', async () => {
            const readsAfterFailure = async (failureRetryMs?: number) => {
                const { state, fetcher } = createFetcher(false);
                let rejected = false;
                const cache = new PromiseCache<string>(fetcher).useInvalidation({ invalidationCheck: () => rejected, failureRetryMs });

                await cache.get('a');
                rejected = true;
                state.fail = true;
                await cache.get('a');
                expect(await cache.get('a')).toBe('value-1');
                await vi.advanceTimersByTimeAsync(50);
                await cache.get('a');
                return fetcher.mock.calls.length;
            };

            expect(await readsAfterFailure()).toBe(4);
            expect(await readsAfterFailure(100)).toBe(2);
        });
    });

    describe('explicit calls', () => {
        test.each<[string, (cache: PromiseCache<string>) => unknown]>([
            ['refresh()', (cache: PromiseCache<string>) => cache.refresh('a')],
            ['delete()', (cache: PromiseCache<string>) => cache.delete('a')],
            ['expire()', (cache: PromiseCache<string>) => cache.expire('a')],
            ['clear()', (cache: PromiseCache<string>) => cache.clear()],
        ])('%s retries a failed fetch at once, however long the wait', async (_name, retry) => {
            const { state, fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ failureRetryMs: Infinity });

            await cache.get('a');
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(1);

            state.fail = false;
            await retry(cache);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(cache.getLastError('a')).toBeNull();
        });

        test('expire() retries once; the failed retry starts the wait again', async () => {
            const { fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ failureRetryMs: 100 });

            await cache.get('a');
            cache.expire('a');
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(101);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(3);
        });
    });

    describe('what the wait leaves alone', () => {
        test('a failed refresh keeps the stored value\'s time in stampedAt and in the invalidationCheck timestamp', async () => {
            const check = vi.fn(() => false);
            const { state, fetcher } = createFetcher(false);
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 100, invalidationCheck: check });

            await cache.get('a');
            const storedAt = Date.now();

            await vi.advanceTimersByTimeAsync(50);
            state.fail = true;
            await cache.refresh('a');

            check.mockClear();
            expect(cache.getState('a').stampedAt).toBe(storedAt);
            expect(check).toHaveBeenLastCalledWith('a', 'value-1', storedAt);
        });

        test('a failed refresh of a value that has not expired starts the wait, which a read once the value expires honors', async () => {
            const { state, fetcher } = createFetcher(false);
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 100, failureRetryMs: 1000 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(50);

            state.fail = true;
            await cache.refresh('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            // 110ms after the store the value has expired, but the failure is only 60ms old
            await vi.advanceTimersByTimeAsync(60);
            expect(await cache.get('a')).toBe('value-1');
            expect(fetcher).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(1000);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(3);
        });

        test('an expired value stays invalid while the retry waits: invalidatedBy is time, and sanitize() sweeps it with its failure time', async () => {
            const { state, fetcher } = createFetcher(false);
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 100 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(101);

            state.fail = true;
            await cache.refresh('a');
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(2);

            expect(cache.getState('a').invalidatedBy).toBe('time');
            expect(cache.getIsValid('a')).toBe(false);
            expect(cache.invalidCount).toBe(1);

            expect(cache.sanitize()).toBe(1);
            expect(cache.hasKey('a')).toBe(false);

            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(3);
        });

        test.each<[string, (cache: PromiseCache<string>) => unknown]>([
            ['set()', (cache: PromiseCache<string>) => { cache.set('a', 'set-value'); }],
            ['a fetch', (cache: PromiseCache<string>) => cache.refresh('a')],
        ])('a value stored by %s clears the failure time, so its lifetime decides the next read', async (_name, store) => {
            const { state, fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 10, failureRetryMs: 100 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(5);

            state.fail = false;
            await store(cache);
            const calls = fetcher.mock.calls.length;

            // 11ms after the store the value has expired, but the failure is only 16ms old
            await vi.advanceTimersByTimeAsync(11);
            await cache.get('a');
            expect(fetcher).toHaveBeenCalledTimes(calls + 1);
        });
    });

    describe('reads', () => {
        test('a paced retry reports loading without a value and revalidating with a stale one', async () => {
            const { state, fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ expirationMs: 100, failureRetryMs: 10 });

            await cache.get('first');
            await vi.advanceTimersByTimeAsync(11);
            const first = cache.get('first');
            expect(cache.getPendingState('first')).toBe('loading');
            await first;

            state.fail = false;
            await cache.get('second');
            await vi.advanceTimersByTimeAsync(101);
            state.fail = true;
            await cache.get('second');
            await vi.advanceTimersByTimeAsync(11);

            const second = cache.get('second');
            expect(cache.getPendingState('second')).toBe('revalidating');
            await second;
        });

        test('getLazy().value follows the wait', async () => {
            const { fetcher } = createFetcher();
            const cache = new PromiseCache<string>(fetcher).useInvalidation({ failureRetryMs: 10 });
            const lazy = cache.getLazy('a');

            await lazy.promise;
            void lazy.value;
            expect(fetcher).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(11);
            void lazy.value;
            expect(fetcher).toHaveBeenCalledTimes(2);
        });
    });
});
