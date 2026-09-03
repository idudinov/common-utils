import { setTimeoutAsync } from '../../async/timeout.js';
import { LazyPromise } from '../promise.js';
import { MappedLazyPromiseView } from '../mapped.js';

describe('MappedLazyPromiseView', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('value maps the source value and triggers loading', async () => {
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const view = new MappedLazyPromiseView(source, v => `n:${v}`);

        expect(view.value).toBe('n:undefined');
        expect(source.isLoading).toBe(true);

        await vi.advanceTimersByTimeAsync(10);

        expect(view.value).toBe('n:1');
    });

    test('currentValue maps without triggering loading', () => {
        const factory = vi.fn(() => setTimeoutAsync(10).then(() => 1));
        const source = new LazyPromise(factory);
        const view = new MappedLazyPromiseView(source, v => `n:${v}`);

        expect(view.currentValue).toBe('n:undefined');
        expect(factory).not.toHaveBeenCalled();
        expect(source.isLoading).toBeNull();
    });

    test('the mapper receives undefined before the first resolve', () => {
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const map = vi.fn((v: number | undefined) => v ?? -1);
        const view = new MappedLazyPromiseView(source, map);

        expect(view.currentValue).toBe(-1);
        expect(map).toHaveBeenCalledWith(undefined);
    });

    test('isLoading, pendingState, hasValue, error, hasResolvedValue() forward to the source', async () => {
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const view = new MappedLazyPromiseView(source, v => v);

        const p = source.promise;
        expect(view.isLoading).toBe(true);
        expect(view.pendingState).toBe('loading');
        expect(view.hasValue).toBe(false);
        expect(view.error).toBeNull();
        expect(view.hasResolvedValue()).toBe(false);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(view.isLoading).toBe(false);
        expect(view.pendingState).toBeNull();
        expect(view.hasValue).toBe(true);
        expect(view.hasResolvedValue()).toBe(true);
    });

    test('error forwards after a failing source load', async () => {
        const error = new Error('fail');
        const source = new LazyPromise<number>(() => setTimeoutAsync(10).then((): number => { throw error; }));
        const view = new MappedLazyPromiseView(source, v => v);

        const p = source.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(view.error).toBe(error);
        expect(view.hasValue).toBe(false);
        expect(view.hasResolvedValue()).toBe(false);
    });

    test('promise on a failed source resolves to the mapped fallback, not a rejection', async () => {
        const error = new Error('fail');
        const source = new LazyPromise<number>(() => setTimeoutAsync(10).then((): number => { throw error; }));
        const map = vi.fn((v: number | undefined) => v ?? -1);
        const view = new MappedLazyPromiseView(source, map);

        const p = view.promise;
        await vi.advanceTimersByTimeAsync(10);

        await expect(p).resolves.toBe(-1);
        expect(view.hasResolvedValue()).toBe(false);
    });

    test('promise resolves to the mapped value', async () => {
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const view = new MappedLazyPromiseView(source, v => `n:${v}`);

        const p = view.promise;
        await vi.advanceTimersByTimeAsync(10);
        const result = await p;

        expect(result).toBe('n:1');
    });

    test('refresh() re-runs the source factory and resolves to the mapped fresh value', async () => {
        let counter = 0;
        const factory = vi.fn(() => setTimeoutAsync(10).then(() => ++counter));
        const source = new LazyPromise(factory);
        const view = new MappedLazyPromiseView(source, v => `n:${v}`);

        const p1 = view.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;

        const refreshPromise = view.refresh();
        await vi.advanceTimersByTimeAsync(10);
        const result = await refreshPromise;

        expect(factory).toHaveBeenCalledTimes(2);
        expect(result).toBe('n:2');
    });

    test('a getter source is resolved on each access', async () => {
        const sourceA = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const sourceB = new LazyPromise(() => setTimeoutAsync(10).then(() => 2));
        let current = sourceA;
        const view = new MappedLazyPromiseView(() => current, v => `n:${v}`);

        const pA = view.promise;
        await vi.advanceTimersByTimeAsync(10);
        expect(await pA).toBe('n:1');

        current = sourceB;

        const pB = view.promise;
        await vi.advanceTimersByTimeAsync(10);
        expect(await pB).toBe('n:2');
    });

    test('a subclass that memoizes value is honored by promise and refresh()', async () => {
        class MemoizedView extends MappedLazyPromiseView<number, { n: number }> {
            private _cache?: { key: number | undefined; result: { n: number } };

            override get value(): { n: number } {
                const src = this._source.value;
                if (!this._cache || this._cache.key !== src) {
                    this._cache = { key: src, result: this._map(src) };
                }
                return this._cache.result;
            }
        }

        let counter = 0;
        const factory = vi.fn(() => setTimeoutAsync(10).then(() => ++counter));
        const source = new LazyPromise(factory);
        const view = new MemoizedView(source, v => ({ n: v ?? -1 }));

        const p1 = view.promise;
        await vi.advanceTimersByTimeAsync(10);
        const result1 = await p1;

        expect(result1).toBe(view.value);

        const refreshPromise = view.refresh();
        await vi.advanceTimersByTimeAsync(10);
        const result2 = await refreshPromise;

        expect(result2).toBe(view.value);
        expect(result2).not.toBe(result1);
    });
});
