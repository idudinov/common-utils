
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { PromiseCache } from '../index.js';
import { delayedError, delayedValue } from './helpers.js';

describe('PromiseCache.expire', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('marks a cached key stale without removing it, no events fired', async () => {
        const cache = new PromiseCache<string>(async id => id);

        const stored = vi.fn();
        const removed = vi.fn();
        const cleared = vi.fn();
        cache.onStored.on(stored);
        cache.onRemoved.on(removed);
        cache.onCleared.on(cleared);

        await cache.get('a');
        stored.mockClear();

        cache.expire('a');

        expect(cache.getIsValid('a')).toBe(false);
        expect(cache.getCurrent('a', false)).toBe('a');
        expect(stored).not.toHaveBeenCalled();
        expect(removed).not.toHaveBeenCalled();
        expect(cleared).not.toHaveBeenCalled();
    });

    test('next get() revalidates while serving the stale value, then settles as valid', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter));

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;
        expect(cache.getCurrent('a', false)).toBe(1);

        cache.expire('a');

        const p = cache.get('a');
        expect(cache.getPendingState('a')).toBe('revalidating');
        expect(cache.getCurrent('a', false)).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(cache.getCurrent('a', false)).toBe(2);
        expect(cache.getIsValid('a')).toBe(true);
    });

    test('a failed revalidation of a force-expired key does not refetch on the immediately following read', async () => {
        let shouldFail = true;
        const cache = new PromiseCache<string>(async () => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 'recovered';
        });

        await cache.get('a');
        cache.expire('a');

        // starting this attempt consumes the sentinel, even though the attempt itself fails
        await cache.get('a');
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        shouldFail = false;
        const result = await cache.get('a');
        expect(result).toBeUndefined(); // sentinel already consumed — no retry, no fetcher call
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        // a further expire() is needed to force another attempt
        cache.expire('a');
        const recovered = await cache.get('a');
        expect(recovered).toBe('recovered');
    });

    test('expire() during an in-flight get() does not abandon the fetch: the result is stored and returned, but the mark survives', async () => {
        let calls = 0;
        const stored = vi.fn();
        const cache = new PromiseCache<number>(async () => { calls++; return delayedValue(10, calls); });
        cache.onStored.on(stored);

        const p = cache.get('a');
        cache.expire('a');

        expect(cache.getPendingState('a')).toBe('loading');
        expect(cache.getIsLoading('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);
        expect(stored).toHaveBeenCalledTimes(1);
        expect(cache.getCurrent('a', false)).toBe(1);
        expect(cache.getIsValid('a')).toBe(false); // the mark survived the settle
        expect(cache.loadingCount).toBe(0);

        const p2 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p2).toBe(2); // a fresh fetch, not the stored value
        expect(cache.getIsValid('a')).toBe(true);
    });

    test('expire() during an in-flight refresh() does not abandon the fetch: the result is stored and returned, but the mark survives', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter));

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;
        expect(cache.getCurrent('a', false)).toBe(1);

        const stored = vi.fn();
        cache.onStored.on(stored);

        const p = cache.refresh('a');
        cache.expire('a');

        expect(cache.getPendingState('a')).toBe('refreshing');
        expect(cache.getIsLoading('a')).toBe(false); // 'refreshing' defaults to a silent background load

        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(2); // the refresh's own result is served, not discarded
        expect(stored).toHaveBeenCalledTimes(1);
        expect(cache.getCurrent('a', false)).toBe(2);
        expect(cache.getIsValid('a')).toBe(false); // the mark survived the settle
        expect(cache.loadingCount).toBe(0);

        const p2 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p2).toBe(3); // a fresh fetch, since the mark survived
        expect(cache.getIsValid('a')).toBe(true);
    });

    test('forced staleness combines with expirationMs: consuming it restores time-based expiry', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => ++counter).useInvalidation({ expirationMs: 100 });

        await cache.get('a');
        expect(cache.getIsValid('a')).toBe(true);

        cache.expire('a');
        expect(cache.getIsValid('a')).toBe(false);

        await cache.get('a'); // consumes the sentinel and refetches, restoring the timestamp to now
        expect(cache.getIsValid('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(101);
        expect(cache.getIsValid('a')).toBe(false); // TTL-based expiry resumes normally
    });

    test('expire() on an errored key (sticky error) makes the next get() refetch', async () => {
        let shouldFail = true;
        const cache = new PromiseCache<string>(async () => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 'recovered';
        });

        await cache.get('a');
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        cache.expire('a');
        shouldFail = false;

        const result = await cache.get('a');
        expect(result).toBe('recovered');
        expect(cache.getLastError('a')).toBeNull();
    });

    test('is a no-op for an unknown key', () => {
        const cache = new PromiseCache<string>(async id => id);

        cache.expire('unknown');

        expect(cache.hasKey('unknown')).toBe(false);
        expect(cache.delete('unknown')).toBe(false);
    });

    test('set() after expire() makes the key valid again', async () => {
        const cache = new PromiseCache<string>(async id => id);

        await cache.get('a');
        cache.expire('a');
        expect(cache.getIsValid('a')).toBe(false);

        cache.set('a', 'fresh');
        expect(cache.getIsValid('a')).toBe(true);
    });

    test('sanitize() removes force-expired keys and fires onRemoved', async () => {
        const cache = new PromiseCache<string>(async id => id);

        const removed: string[] = [];
        cache.onRemoved.on(({ key }) => { removed.push(key); });

        await cache.get('a');
        await cache.get('b');

        cache.expire('a');

        expect(cache.invalidCount).toBe(1);
        expect(cache.sanitize()).toBe(1);
        expect(cache.hasKey('a')).toBe(false);
        expect(cache.hasKey('b')).toBe(true);
        expect(removed).toEqual(['a']);
    });

    test('works with no InvalidationConfig configured', async () => {
        const cache = new PromiseCache<string>(async id => id);

        await cache.get('a');
        expect(cache.getIsValid('a')).toBe(true);

        cache.expire('a');
        expect(cache.getIsValid('a')).toBe(false);
    });

    test('invalidCount includes force-expired keys', async () => {
        const cache = new PromiseCache<string>(async id => id);

        await cache.get('a');
        await cache.get('b');
        expect(cache.invalidCount).toBe(0);

        cache.expire('a');
        expect(cache.invalidCount).toBe(1);
    });

    test('a failed revalidation restores the original resolve time, so TTL expiry still lands on schedule', async () => {
        let shouldFail = false;
        const cache = new PromiseCache<string>(async () => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 'value';
        }).useInvalidation({ expirationMs: 1000 });

        await cache.get('a'); // resolves at t0
        expect(cache.getIsValid('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        cache.expire('a'); // at t500 — the original t0 resolve time is preserved, not overwritten

        shouldFail = true;
        await cache.get('a'); // consumes the forced expiry, restores the t0 timestamp, then fails

        // t500, only 500ms since t0: the restored (real) age is still under the 1000ms TTL —
        // if the consumption had written Date.now() instead, this would stay valid until t1500
        expect(cache.getIsValid('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(600); // now at t1100 — past the original TTL window
        expect(cache.getIsValid('a')).toBe(false);
    });

    test('expire() called twice then a successful fetch leaves timestamps behaving normally', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => ++counter).useInvalidation({ expirationMs: 1000 });

        await cache.get('a');
        cache.expire('a');
        cache.expire('a'); // second call must not double-negate the stored timestamp

        const result = await cache.get('a');
        expect(result).toBe(2);
        expect(cache.getIsValid('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(1001);
        expect(cache.getIsValid('a')).toBe(false); // TTL expiry still works after the expire() cycle
    });

    test('expiring a key whose first-ever fetch is in flight lets that fetch complete and store its result', async () => {
        const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

        const p = cache.get('a');
        cache.expire('a');

        expect(cache.hasKey('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);
        expect(cache.hasKey('a')).toBe(true);
        expect(cache.getCurrent('a', false)).toBe(1);
        expect(cache.getIsValid('a')).toBe(false); // the mark survived the settle
    });

    test('the mutation race: a refetch in flight when expire() lands still stores its (stale) result, and the next get() refetches again', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter))
            .useInvalidation({ expirationMs: 50 });

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;
        expect(cache.getCurrent('a', false)).toBe(1);

        await vi.advanceTimersByTimeAsync(51); // value goes stale, a read now starts a background refetch
        const p = cache.get('a');
        expect(cache.getCurrent('a', false)).toBe(1); // stale value served while the refetch is in flight

        cache.expire('a'); // a mutation lands mid-flight; the in-flight refetch predates it

        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(2); // the in-flight result is stored and served regardless
        expect(cache.getCurrent('a', false)).toBe(2);
        expect(cache.getIsValid('a')).toBe(false); // the mark survived, so this result doesn't satisfy the mutation

        const p2 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p2).toBe(3); // the next get() refetches, this time reflecting the mutation
    });

    test('expire() during an in-flight fetch that fails: the next get() retries once, then goes sticky', async () => {
        let attempt = 0;
        const cache = new PromiseCache<string>(async () => {
            attempt++;
            return delayedError(10, new Error(`fail-${attempt}`));
        });

        const p = cache.get('a');
        cache.expire('a');

        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(cache.getLastError('a')).toHaveProperty('message', 'fail-1');

        // the mark survived the failed settle — one retry
        const p2 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p2;
        expect(attempt).toBe(2);
        expect(cache.getLastError('a')).toHaveProperty('message', 'fail-2');

        // sticky again — a further get() must not retry
        await cache.get('a');
        expect(attempt).toBe(2);
    });

    test('expire() before a fetch starts, followed by a failed fetch, goes sticky with no retry', async () => {
        let attempt = 0;
        let shouldFail = false;
        const cache = new PromiseCache<string>(async () => {
            attempt++;
            if (shouldFail) {
                throw new Error(`fail-${attempt}`);
            }
            return 'ok';
        });

        await cache.get('a');
        expect(attempt).toBe(1);

        cache.expire('a');
        shouldFail = true;

        await cache.get('a'); // consumes the mark at invocation, then fails
        expect(attempt).toBe(2);
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        await cache.get('a'); // sticky — no retry
        expect(attempt).toBe(2);
    });

    test('expire() on an errored key under useInvalidation(expirationMs) triggers one retry, not a TTL loop', async () => {
        let attempt = 0;
        const cache = new PromiseCache<string>(async () => {
            attempt++;
            throw new Error(`fail-${attempt}`);
        }).useInvalidation({ expirationMs: 100 });

        await cache.get('a');
        expect(attempt).toBe(1);

        cache.expire('a');

        await cache.get('a'); // one retry — the mark is consumed at invocation
        expect(attempt).toBe(2);

        // sticky again: further reads, even much later, must not turn into a TTL-paced loop
        await vi.advanceTimersByTimeAsync(1000);
        await cache.get('a');
        expect(attempt).toBe(2);
    });
});
