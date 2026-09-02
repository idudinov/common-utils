
import { ExpireTracker } from '../../structures/expire.js';
import { LazyPromise } from '../promise.js';

/** Helper: creates a promise that resolves after `ms` milliseconds (works with fake timers). */
function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

describe('LazyPromise.expireTracker', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('default tracker: present on an unconfigured instance, behaves like no expiry until expire() is called', async () => {
        let counter = 0;
        const lazy = new LazyPromise(() => delay(10).then(() => ++counter));

        expect(lazy.expireTracker).toBeDefined();
        expect(lazy.expireTracker.isExpired).toBeFalse();

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.value).toBe(1);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(lazy.expireTracker.isExpired).toBeFalse();
        expect(lazy.value).toBe(1); // never expires on its own
        expect(lazy.pendingState).toBeNull();

        lazy.expireTracker.expire();
        expect(lazy.expireTracker.isExpired).toBeTrue();
    });

    test('expire() after resolve starts a revalidation while value/hasValue keep the stale value', async () => {
        let counter = 0;
        const lazy = new LazyPromise(() => delay(10).then(() => ++counter));

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.value).toBe(1);

        lazy.expireTracker.expire();

        expect(lazy.value).toBe(1); // starts a revalidation, stale value kept
        expect(lazy.pendingState).toBe('revalidating');
        expect(lazy.hasValue).toBeTrue();

        const p2 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p2;
        expect(lazy.value).toBe(2);
        expect(lazy.pendingState).toBeNull();
    });

    test('a successful settle clears staleness — no second refetch', async () => {
        let counter = 0;
        const factory = vi.fn(() => delay(10).then(() => ++counter));
        const lazy = new LazyPromise(factory);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(factory).toHaveBeenCalledTimes(1);

        lazy.expireTracker.expire();
        const p2 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p2;
        expect(factory).toHaveBeenCalledTimes(2);

        // the settle above restarted the tracker — a further read must not trigger another load
        expect(lazy.value).toBe(2);
        expect(factory).toHaveBeenCalledTimes(2);
        expect(lazy.pendingState).toBeNull();
    });

    test('a failed load with the default tracker retries only after another expire() call', async () => {
        let shouldFail = true;
        const factory = vi.fn(async () => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 42;
        });
        const lazy = new LazyPromise(factory);

        await lazy.promise;
        expect(lazy.error).toBeInstanceOf(Error);
        expect(factory).toHaveBeenCalledTimes(1);

        // the failed attempt above already restarted the (never-expiring) tracker — a passive read must not retry
        expect(lazy.value).toBeUndefined();
        expect(factory).toHaveBeenCalledTimes(1);

        lazy.expireTracker.expire();
        await lazy.promise;
        expect(lazy.error).toBeInstanceOf(Error);
        expect(factory).toHaveBeenCalledTimes(2);

        lazy.expireTracker.expire();
        shouldFail = false;
        const result = await lazy.promise;

        expect(factory).toHaveBeenCalledTimes(3);
        expect(result).toBe(42);
        expect(lazy.hasValue).toBeTrue();
    });

    test('a failed load with withExpire(N) retries after the lifetime elapses, without a manual expire()', async () => {
        let shouldFail = true;
        const factory = vi.fn(async () => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 42;
        });
        const lazy = new LazyPromise(factory).withExpire(1000);

        await lazy.promise;
        expect(lazy.error).toBeInstanceOf(Error);
        expect(factory).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(999);
        void lazy.value; // passive read; the lifetime hasn't elapsed yet — must not retry
        expect(factory).toHaveBeenCalledTimes(1);

        shouldFail = false;
        await vi.advanceTimersByTimeAsync(2);
        const result = await lazy.promise;

        expect(factory).toHaveBeenCalledTimes(2);
        expect(result).toBe(42);
        expect(lazy.hasValue).toBeTrue();
    });

    test('withExpire(undefined) resets to a never-expiring owned tracker', async () => {
        let counter = 0;
        const lazy = new LazyPromise(() => delay(10).then(() => ++counter)).withExpire(10);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;

        lazy.withExpire(undefined);

        expect(lazy.expireTracker).toBeDefined();
        expect(lazy.expireTracker.isExpired).toBeFalse();

        await vi.advanceTimersByTimeAsync(20);
        expect(lazy.expireTracker.isExpired).toBeFalse();
        expect(lazy.value).toBe(1); // no revalidation
        expect(lazy.pendingState).toBeNull();
    });

    test('withExpire(number) constructs an owned tracker; value expires after the lifetime', async () => {
        let counter = 0;
        const lazy = new LazyPromise(() => delay(10).then(() => ++counter)).withExpire(20);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.value).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        expect(lazy.value).toBe(1); // not yet expired, no revalidation
        expect(lazy.pendingState).toBeNull();

        await vi.advanceTimersByTimeAsync(11);
        expect(lazy.value).toBe(1); // starts a passive revalidation
        expect(lazy.pendingState).toBe('revalidating');

        const p2 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p2;
        expect(lazy.value).toBe(2);
    });

    test('withExpire(tracker) attaches the given tracker instance directly', async () => {
        let counter = 0;
        const tracker = new ExpireTracker(1000);
        const lazy = new LazyPromise(() => delay(10).then(() => ++counter)).withExpire(tracker);

        expect(lazy.expireTracker).toBe(tracker);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(tracker.isExpired).toBeFalse();
    });
});
