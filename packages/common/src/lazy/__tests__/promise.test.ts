
import { ExpireTracker } from '../../structures/expire.js';
import { LazyPromise } from '../promise.js';

/** Helper: creates a promise that resolves after `ms` milliseconds (works with fake timers). */
function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

describe('LazyPromise', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('simple', async () => {
        const VAL = 'abc';
        const l = new LazyPromise(() => delay(100).then(() => VAL));

        expect(l.hasValue).toBeFalse();
        expect(l.currentValue).toBeUndefined();
        expect(l.isLoading).toBeNull();

        expect(l.value).toBeUndefined();
        expect(l.isLoading).toBeTrue();

        const p = l.promise;
        await vi.advanceTimersByTimeAsync(100);
        await expect(p).resolves.not.toThrow();

        expect(l.hasValue).toBeTrue();
        expect(l.isLoading).toBeFalse();
        expect(l.value).toBe(VAL);
        expect(l.currentValue).toBe(VAL);

        l.dispose();
        expect(l.hasValue).toBeFalse();
    });

    test('setInstance', async () => {
        const VAL = 'abc1';
        const factory = vi.fn(() => delay(10).then(() => VAL));
        const l = new LazyPromise(factory);

        expect(l.hasValue).toBeFalse();
        expect(l.isLoading).toBeNull();

        expect(l.value).toBeUndefined();
        expect(l.isLoading).toBeTrue();

        const p = l.promise;

        const VAL2 = 'abc2';
        l.setInstance(VAL2);

        // Advance timer so the original factory promise resolves (abandoned, returns setInstance value)
        await vi.advanceTimersByTimeAsync(10);

        await expect(p).resolves.toBe(VAL2);
        await expect(l.promise).resolves.toBe(VAL2);

        const VAL3 = 'abc3';
        l.setInstance(VAL3);
        await expect(l.promise).resolves.toBe(VAL3);
    });

    test('with expire', async () => {
        let incrementor = 0;

        const expire = new ExpireTracker(10);

        const l = new LazyPromise(() => delay(10).then(() => ++incrementor))
            .withExpire(expire);

        expect(l.hasValue).toBeFalse();
        expect(l.isLoading).toBeFalsy();

        expect(l.value).toBeUndefined();
        expect(l.isLoading).toBeTrue();

        const next = incrementor + 1;
        const p1 = l.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p1).resolves.toBe(next);
        expect(incrementor).toBe(next);

        expect(l.hasValue).toBeTrue();
        expect(l.isLoading).toBeFalse();
        expect(l.value).toBe(1);
        expect(expire.isExpired).toBeFalse();
        expect(expire.remainingMs).toBeLessThanOrEqual(10);

        await vi.advanceTimersByTimeAsync(11);

        expect(expire.isExpired).toBeTrue();
        expect(l.hasValue).toBeTrue();
        expect(l.value).toBe(1);

        const p2 = l.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p2).resolves.toBe(2);
        expect(incrementor).toBe(2);
        expect(expire.isExpired).toBeFalse();

        expire.expire();
        expect(expire.isExpired).toBeTrue();
        expect(l.hasValue).toBeTrue();
        expect(l.value).toBe(2);
        const p3 = l.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p3).resolves.toBe(3);
        expect(incrementor).toBe(3);
        expect(expire.isExpired).toBeFalse();
        expect(l.value).toBe(3);
    });

    test('disposes', async () => {
        const disposer = vi.fn();

        const l = new LazyPromise(async () => ({
            value: 42,
            dispose() {
                disposer();
            },
        }));

        await l.promise;

        expect(l.value).toBeDefined();
        expect(l.value?.value).toBe(42);
        expect(l.hasValue).toBeTrue();

        l.dispose();
        expect(l.hasValue).toBeFalse();
        expect(disposer).toHaveBeenCalledTimes(1);
    });

    test('with initial value', async () => {
        const lazy = new LazyPromise(async () => {
            await delay(10);
            return { result: 42 };
        }, { result: 10 });

        expect(lazy.hasValue).toBeFalse();
        expect(lazy.isLoading).toBeNull();

        expect(lazy.value.result).toBe(10);
        expect(lazy.isLoading).toBeTrue();

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p).resolves.toEqual({ result: 42 });

        expect(lazy.value.result).toBe(42);
        expect(lazy.hasValue).toBeTrue();
        expect(lazy.isLoading).toBeFalse();
    });

    test('with no initial value', async () => {
        const lazy = new LazyPromise(async () => {
            await delay(10);
            return { result: 42 };
        });

        expect(lazy.hasValue).toBeFalse();
        expect(lazy.isLoading).toBeNull();
        expect(lazy.currentValue).toBeUndefined();

        expect(lazy.value).toBeUndefined();
        expect(() => {
            // @ts-expect-error Type is `T | undefined` — accessing `.result` on a possibly-undefined value is a type error
            return lazy.value.result;
        }).toThrow();

        expect(lazy.isLoading).toBeTrue();

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await expect(p).resolves.toEqual({ result: 42 });

        // @ts-expect-error Type is still `T | undefined` (no initial value), so `.result` access is a type error even though value is loaded
        expect(lazy.value.result).toBe(42);
        expect(lazy.hasValue).toBeTrue();
        expect(lazy.isLoading).toBeFalse();
    });

    test('async state change', async () => {
        const lazy = new LazyPromise(async () => {
            await delay(10);
            return { result: 42 };
        }).withAsyncStateChange(true);

        expect(lazy.hasValue).toBeFalse();
        expect(lazy.isLoading).toBeNull();
        expect(lazy.currentValue).toBeUndefined();

        expect(lazy.value).toBeUndefined();
        expect(lazy.isLoading).toBeNull();

        await vi.advanceTimersByTimeAsync(0);
        expect(lazy.isLoading).toBeTrue();

        await vi.advanceTimersByTimeAsync(11);
        await expect(lazy.promise).resolves.toEqual({ result: 42 });
        expect(lazy.isLoading).toBeFalse();
        expect(lazy.hasValue).toBeTrue();
        expect(lazy.value!.result).toBe(42);
    });
});
