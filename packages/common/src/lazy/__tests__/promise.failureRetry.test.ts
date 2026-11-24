
import { LazyPromise } from '../promise.js';

/** A factory that rejects while `state.fail` is set; resolves to the call number otherwise. */
function createFactory(fail = true) {
    const state = { fail, calls: 0 };
    const factory = vi.fn(async () => {
        state.calls++;
        if (state.fail) {
            throw new Error('fail');
        }
        return state.calls;
    });
    return { state, factory };
}

describe('LazyPromise.withFailureRetry', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('0 retries on every read, with no withExpire', async () => {
        const { state, factory } = createFactory();
        const lazy = new LazyPromise(factory).withFailureRetry(0);

        await lazy.promise;
        await lazy.promise;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(3);

        state.fail = false;
        await lazy.promise;
        expect(lazy.hasValue).toBeTrue();
        expect(lazy.currentValue).toBe(4);
    });

    test('0 retries a failed revalidation on every read, serving the stale value', async () => {
        const { state, factory } = createFactory(false);
        const lazy = new LazyPromise(factory).withExpire(100).withFailureRetry(0);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(101);

        state.fail = true;
        await lazy.promise;
        await lazy.promise;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(4);
        expect(lazy.currentValue).toBe(1);
        expect(lazy.error).toBeInstanceOf(Error);
    });

    test('Infinity never retries on a read, however short the lifetime', async () => {
        const { state, factory } = createFactory();
        const lazy = new LazyPromise(factory).withExpire(10).withFailureRetry(Infinity);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(1000);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(1);

        state.fail = false;
        await lazy.refresh();
        expect(factory).toHaveBeenCalledTimes(2);
        expect(lazy.hasValue).toBeTrue();
    });

    test('Infinity never retries a failed revalidation of an expired value on a read', async () => {
        const { state, factory } = createFactory(false);
        const lazy = new LazyPromise(factory).withExpire(10).withFailureRetry(Infinity);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(11);

        state.fail = true;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1000);
        expect(await lazy.promise).toBe(1);
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test('a number paces retries, with no withExpire', async () => {
        const { state, factory } = createFactory();
        const lazy = new LazyPromise(factory).withFailureRetry(50);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(49);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);

        // the second failure restarts the wait
        await vi.advanceTimersByTimeAsync(49);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);

        state.fail = false;
        await vi.advanceTimersByTimeAsync(2);
        expect(await lazy.promise).toBe(3);
        expect(lazy.hasValue).toBeTrue();
    });

    test('a number replaces the lifetime as the wait, for a failed first load and a failed revalidation', async () => {
        const { state, factory } = createFactory();
        const lazy = new LazyPromise(factory).withExpire(1000).withFailureRetry(10);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(11);
        state.fail = false;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1001);
        state.fail = true;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(9);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(2);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(4);
    });

    test.each([0, 10, Infinity])('%s leaves the lifetime of a resolved value as withExpire sets it', async ms => {
        const { factory } = createFactory(false);
        const lazy = new LazyPromise(factory).withExpire(100).withFailureRetry(ms);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(99);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test.each<[string, (lazy: LazyPromise<number>) => unknown]>([
        ['refresh()', (lazy: LazyPromise<number>) => lazy.refresh()],
        ['reset()', (lazy: LazyPromise<number>) => { lazy.reset(); }],
        ['expireTracker.expire()', (lazy: LazyPromise<number>) => { lazy.expireTracker.expire(); }],
    ])('%s retries a failed load at once, however long the wait', async (_name, retry) => {
        const { state, factory } = createFactory();
        const lazy = new LazyPromise(factory).withFailureRetry(Infinity);

        await lazy.promise;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(1);

        state.fail = false;
        await retry(lazy);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);
        expect(lazy.hasValue).toBeTrue();
    });

    test.each<[string, (lazy: LazyPromise<number>) => unknown]>([
        ['refresh()', (lazy: LazyPromise<number>) => lazy.refresh()],
        ['setInstance()', (lazy: LazyPromise<number>) => { lazy.setInstance(100); }],
    ])('a value stored by %s clears the failure time, so its lifetime decides the next read', async (_name, store) => {
        const { state, factory } = createFactory();
        const lazy = new LazyPromise(factory).withExpire(10).withFailureRetry(100);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(5);

        state.fail = false;
        await store(lazy);
        const calls = factory.mock.calls.length;

        // 11ms after the store the value has expired, but the failure is only 16ms old
        await vi.advanceTimersByTimeAsync(11);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(calls + 1);
    });

    test('a custom tracker decides when a read retries, and each failed load restarts it', async () => {
        const { factory } = createFactory();
        const tracker = { isExpired: false, isForceExpired: false, restart: vi.fn(), expire: vi.fn() };
        const lazy = new LazyPromise(factory).withFailureRetry(tracker);

        await lazy.promise;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(1);
        expect(tracker.restart).toHaveBeenCalledTimes(1);

        tracker.isExpired = true;
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);
        expect(tracker.restart).toHaveBeenCalledTimes(2);
    });

    test('undefined removes the failure wait, so the expire tracker paces retries again', async () => {
        const { factory } = createFactory();
        const lazy = new LazyPromise(factory).withExpire(10).withFailureRetry(Infinity).withFailureRetry(undefined);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(11);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test('a wait set while a failure stands counts from then', async () => {
        const { factory } = createFactory();
        const lazy = new LazyPromise(factory);

        await lazy.promise;
        await vi.advanceTimersByTimeAsync(40);
        lazy.withFailureRetry(50);

        await vi.advanceTimersByTimeAsync(49);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2);
        await lazy.promise;
        expect(factory).toHaveBeenCalledTimes(2);
    });

    test('a paced retry reports loading without a value and revalidating with a stale one', async () => {
        const first = createFactory();
        const withoutValue = new LazyPromise(first.factory).withFailureRetry(10);

        await withoutValue.promise;
        await vi.advanceTimersByTimeAsync(11);
        void withoutValue.value;
        expect(withoutValue.pendingState).toBe('loading');

        const second = createFactory(false);
        const withValue = new LazyPromise(second.factory).withExpire(100).withFailureRetry(10);

        await withValue.promise;
        await vi.advanceTimersByTimeAsync(101);
        second.state.fail = true;
        await withValue.promise;
        await vi.advanceTimersByTimeAsync(11);
        void withValue.value;
        expect(withValue.pendingState).toBe('revalidating');
    });
});
