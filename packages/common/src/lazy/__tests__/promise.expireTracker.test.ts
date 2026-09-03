
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

    test('a successful settle clears staleness — no second refetch, for a mark set before the load starts', async () => {
        let counter = 0;
        const factory = vi.fn(() => delay(10).then(() => ++counter));
        const lazy = new LazyPromise(factory);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(factory).toHaveBeenCalledTimes(1);

        lazy.expireTracker.expire(); // marked stale before any load is in flight
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

    test('withExpire(tracker) attaches the given tracker instance directly; it drives revalidation like an owned one', async () => {
        let counter = 0;
        const tracker = new ExpireTracker(1000);
        const lazy = new LazyPromise(() => delay(10).then(() => ++counter)).withExpire(tracker);

        expect(lazy.expireTracker).toBe(tracker);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.value).toBe(1);

        await vi.advanceTimersByTimeAsync(1001);
        expect(lazy.value).toBe(1); // starts a revalidation
        expect(lazy.pendingState).toBe('revalidating');

        const p2 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p2;
        expect(lazy.value).toBe(2);
    });

    test('withExpire(N) on an already-loaded value restarts the tracker; the next read revalidates once it elapses', async () => {
        let counter = 0;
        const lazy = new LazyPromise(() => delay(10).then(() => ++counter));

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(lazy.value).toBe(1);

        lazy.withExpire(20);

        await vi.advanceTimersByTimeAsync(20);
        expect(lazy.value).toBe(1); // starts a revalidation
        expect(lazy.pendingState).toBe('revalidating');

        const p2 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p2;
        expect(lazy.value).toBe(2);
    });

    test('expire() mid-flight survives the in-flight load\'s settle', async () => {
        const factory = vi.fn(() => delay(10).then(() => 1));
        const lazy = new LazyPromise(factory);

        const p1 = lazy.promise;
        lazy.expireTracker.expire();

        await vi.advanceTimersByTimeAsync(10);
        await expect(p1).resolves.toBe(1);

        expect(lazy.expireTracker.isForceExpired).toBeTrue();
        expect(lazy.expireTracker.isExpired).toBeTrue();
        expect(factory).toHaveBeenCalledTimes(1);
        expect(lazy.pendingState).toBeNull();
    });

    test('the mutation race: expire() mid-load survives the settle, and the next read re-invokes the factory', async () => {
        let counter = 0;
        const factory = vi.fn(() => delay(10).then(() => ++counter));
        const lazy = new LazyPromise(factory);

        const p1 = lazy.promise;
        lazy.expireTracker.expire();

        await vi.advanceTimersByTimeAsync(10);
        await expect(p1).resolves.toBe(1);
        expect(lazy.currentValue).toBe(1);
        expect(factory).toHaveBeenCalledTimes(1);

        const p2 = lazy.promise; // the mark survived the settle — this read re-invokes the factory
        await vi.advanceTimersByTimeAsync(10);
        await expect(p2).resolves.toBe(2);
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test('a load slower than its own lifetime settles as fresh, not stale', async () => {
        const factory = vi.fn(() => delay(20).then(() => 1));
        const lazy = new LazyPromise(factory).withExpire(10);

        const p1 = lazy.promise;
        await vi.advanceTimersByTimeAsync(20);
        await expect(p1).resolves.toBe(1);

        expect(lazy.expireTracker.isForceExpired).toBeFalse();
        expect(lazy.expireTracker.isExpired).toBeFalse();
        expect(lazy.currentValue).toBe(1);

        // the settle restarted the tracker — a read right after resolve must not trigger a second load
        void lazy.value;
        expect(factory).toHaveBeenCalledTimes(1);
    });

    test('setInstance() after expireTracker.expire() clears the mark; a fetch settle does not', async () => {
        const lazy = new LazyPromise(() => Promise.resolve(1));

        lazy.expireTracker.expire();
        expect(lazy.expireTracker.isForceExpired).toBeTrue();

        lazy.setInstance(2);

        expect(lazy.expireTracker.isForceExpired).toBeFalse();
        expect(lazy.expireTracker.isExpired).toBeFalse();
        expect(lazy.currentValue).toBe(2);
    });

    test('a joined .value read mid-flight does not restart a shared tracker', async () => {
        const tracker = new ExpireTracker(1000);
        const lazy = new LazyPromise(() => delay(10).then(() => 1)).withExpire(tracker);

        const p1 = lazy.promise; // starts the load, restarts the tracker
        expect(tracker.remainingMs).toBe(1000);

        await vi.advanceTimersByTimeAsync(5);
        expect(tracker.remainingMs).toBe(995);

        void lazy.value; // joined read while still in flight — must not restart the tracker

        expect(tracker.remainingMs).toBe(995);

        await vi.advanceTimersByTimeAsync(5);
        await p1;
    });
});
