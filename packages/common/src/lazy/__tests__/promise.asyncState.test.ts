import { LazyPromise } from '../promise.js';

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

    test('reset() is not overridden by a scheduled deferred state write', async () => {
        const lazy = new LazyPromise(() => new Promise<number>(() => { /* never settles */ })).withAsyncStateChange(true);

        expect(lazy.value).toBeUndefined();
        lazy.reset();
        await flushMicrotasks();

        expect(lazy.isLoading).toBeNull();
        expect(lazy.pendingState).toBeNull();
    });
});
