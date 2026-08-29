import { setTimeoutAsync } from '../../async/timeout.js';
import { ExpireTracker } from '../../structures/expire.js';
import { LazyPromise } from '../promise.js';

describe('LazyPromise loading state strategy', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('{ refreshing: true } reports isLoading during a warm refresh, stale value stays available', async () => {
        let counter = 0;
        const lazy = new LazyPromise(async () => {
            await setTimeoutAsync(10);
            return ++counter;
        }).withLoadingState({ refreshing: true });

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(lazy.value).toBe(1);
        expect(lazy.isLoading).toBeFalse();

        const refreshPromise = lazy.refresh();
        expect(lazy.isLoading).toBeTrue();
        expect(lazy.currentValue).toBe(1); // stale value stays available mid-flight

        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;
        expect(lazy.isLoading).toBeFalse();
        expect(lazy.value).toBe(2);
    });

    test('{ "refreshing:cold": true } reports isLoading during a cold refresh', async () => {
        let counter = 0;
        const lazy = new LazyPromise(async () => {
            await setTimeoutAsync(10);
            return ++counter;
        }).withLoadingState({ 'refreshing:cold': true });

        expect(lazy.isLoading).toBeNull();

        const refreshPromise = lazy.refresh();
        expect(lazy.isLoading).toBeTrue();

        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;
        expect(lazy.isLoading).toBeFalse();
        expect(lazy.value).toBe(1);
    });

    test('{ revalidating: false } silences isLoading during passive revalidation of an expired value', async () => {
        const expire = new ExpireTracker(10);
        let counter = 0;
        const lazy = new LazyPromise(async () => {
            await setTimeoutAsync(10);
            return ++counter;
        }).withExpire(expire).withLoadingState({ revalidating: false });

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(lazy.value).toBe(1);

        await vi.advanceTimersByTimeAsync(11);
        expect(expire.isExpired).toBeTrue();

        expect(lazy.value).toBe(1); // stale value returned while revalidating
        expect(lazy.isLoading).toBeFalse(); // silenced by strategy
        expect(lazy.hasValue).toBeTrue();

        await vi.advanceTimersByTimeAsync(10);
        expect(await lazy.promise).toBe(2);
        expect(lazy.value).toBe(2);
        expect(lazy.isLoading).toBeFalse();
    });

    test('silent passive revalidation superseded by an explicit refresh', async () => {
        const expire = new ExpireTracker(10);
        let counter = 0;
        const lazy = new LazyPromise(async () => {
            await setTimeoutAsync(20);
            return ++counter;
        }).withExpire(expire).withLoadingState({ revalidating: false });

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(20);
        await p;
        expect(lazy.value).toBe(1);

        await vi.advanceTimersByTimeAsync(11);
        expect(lazy.value).toBe(1); // starts a silent revalidation
        expect(lazy.isLoading).toBeFalse();

        const refreshPromise = lazy.refresh(); // supersedes the silent revalidation
        await vi.advanceTimersByTimeAsync(20);
        const refreshResult = await refreshPromise;
        expect(refreshResult).toBe(3);
        expect(lazy.value).toBe(3);
        expect(counter).toBe(3);
    });

    test('setInstance called mid-silent-revalidation wins over the in-flight factory result', async () => {
        const expire = new ExpireTracker(10);
        let counter = 0;
        const lazy = new LazyPromise(async () => {
            await setTimeoutAsync(10);
            return ++counter;
        }).withExpire(expire).withLoadingState({ revalidating: false });

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(lazy.value).toBe(1);

        await vi.advanceTimersByTimeAsync(11);
        expect(lazy.value).toBe(1); // starts a silent revalidation

        lazy.setInstance(100);
        expect(lazy.value).toBe(100);
        expect(lazy.hasValue).toBeTrue();

        await vi.advanceTimersByTimeAsync(10); // let the abandoned factory settle
        expect(counter).toBe(2); // factory did run, but its result was discarded
        expect(lazy.value).toBe(100);
    });

    test('strategy is read live: getter-based fields re-evaluate on each isLoading read', async () => {
        let loud = false;
        const lazy = new LazyPromise(async () => {
            await setTimeoutAsync(10);
            return 1;
        }).withLoadingState({ get refreshing() { return loud; } });

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;

        const refreshPromise = lazy.refresh();
        expect(lazy.isLoading).toBeFalse();

        loud = true;
        expect(lazy.isLoading).toBeTrue();

        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;
        expect(lazy.isLoading).toBeFalse();
    });

    test('isLoading path-dependence at defaults: cold refresh stays null, refresh after a failed load stays false', async () => {
        let shouldFail = true;
        const lazy = new LazyPromise(async () => {
            await setTimeoutAsync(10);
            if (shouldFail) {
                throw new Error('fail');
            }
            return 1;
        });

        const coldRefresh = lazy.refresh();
        expect(lazy.isLoading).toBeNull();
        await vi.advanceTimersByTimeAsync(10);
        await coldRefresh;
        expect(lazy.isLoading).toBeFalse();
        expect(lazy.error).toBeInstanceOf(Error);

        shouldFail = false;
        const recoveryRefresh = lazy.refresh();
        expect(lazy.isLoading).toBeFalse();
        await vi.advanceTimersByTimeAsync(10);
        await recoveryRefresh;
        expect(lazy.isLoading).toBeFalse();
        expect(lazy.value).toBe(1);
    });
});
