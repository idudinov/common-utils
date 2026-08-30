import { LazyPromise } from '../promise.js';
import { ExpireTracker } from '../../structures/expire.js';

async function flushMicrotasks(count = 5) {
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
    }
}

describe('LazyPromise with withAsyncStateChange(true)', () => {

    test('first load via .value with a fast-settling factory ends not loading', async () => {
        const lazy = new LazyPromise(() => Promise.resolve(42)).withAsyncStateChange(true);

        expect(lazy.value).toBeUndefined();
        await lazy.promise;
        await flushMicrotasks();

        expect(lazy.hasValue).toBe(true);
        expect(lazy.isLoading).toBe(false);
        expect(lazy.currentValue).toBe(42);
        expect(lazy.pendingState).toBeNull();
    });

    test('refresh() with a fast-settling factory ends not loading', async () => {
        const lazy = new LazyPromise(() => Promise.resolve(42)).withAsyncStateChange(true);

        await lazy.refresh();
        await flushMicrotasks();

        expect(lazy.hasValue).toBe(true);
        expect(lazy.isLoading).toBe(false);
        expect(lazy.currentValue).toBe(42);
        expect(lazy.pendingState).toBeNull();
    });

    test('refresh() called in the same tick as a deferred revalidation write wins the race', async () => {
        const resolvers: ((v: number) => void)[] = [];
        const expire = new ExpireTracker(10_000);
        const lazy = new LazyPromise(() => new Promise<number>(r => resolvers.push(r)))
            .withAsyncStateChange(true)
            .withExpire(expire)
            .withLoadingState({ refreshing: true });

        const p1 = lazy.promise;
        resolvers.shift()!(1);
        await p1;
        expect(lazy.hasValue).toBe(true);

        expire.expire();

        void lazy.value; // defers a 'revalidating' write
        const refreshPromise = lazy.refresh(); // defers a 'refreshing' write in the same tick

        await flushMicrotasks();

        expect(lazy.pendingState).toBe('refreshing');
        expect(lazy.isLoading).toBe(true);

        resolvers.forEach(r => r(2));
        expect(await refreshPromise).toBe(2);

        expect(lazy.pendingState).toBeNull();
        expect(lazy.value).toBe(2);
    });

    test('reset() is not overridden by a scheduled deferred state write', async () => {
        const lazy = new LazyPromise(() => new Promise<number>(() => { /* never settles */ })).withAsyncStateChange(true);

        expect(lazy.value).toBeUndefined();
        lazy.reset();
        await flushMicrotasks();

        expect(lazy.isLoading).toBeNull();
        expect(lazy.pendingState).toBeNull();
    });
});
