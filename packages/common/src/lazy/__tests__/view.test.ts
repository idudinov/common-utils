import { setTimeoutAsync } from '../../async/timeout.js';
import { LazyPromise } from '../promise.js';
import { LazyPromiseView } from '../view.js';

class ValueOverrideView<T, TI extends T | undefined = undefined> extends LazyPromiseView<T, TI> {
    constructor(source: LazyPromise<T, TI>, private readonly _value: T) {
        super(source);
    }

    override get value() { return this._value; }
}

describe('LazyPromiseView', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('subclass overriding one member forwards the rest to the source', async () => {
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const view = new ValueOverrideView(source, 42);

        expect(view.value).toBe(42);
        expect(view.currentValue).toBe(source.currentValue);
        expect(view.hasValue).toBe(source.hasValue);
        expect(view.error).toBe(source.error);
        expect(view.isLoading).toBe(source.isLoading);
        expect(view.pendingState).toBe(source.pendingState);

        const p = source.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(view.value).toBe(42); // still overridden after settle
        expect(view.currentValue).toBe(source.currentValue);
        expect(view.hasValue).toBe(source.hasValue);
        expect(view.hasResolvedValue()).toBe(source.hasResolvedValue());
    });

    test('refresh() and promise forward to the source', async () => {
        let counter = 0;
        const factory = vi.fn(() => setTimeoutAsync(10).then(() => ++counter));
        const source = new LazyPromise(factory);
        const view = new ValueOverrideView(source, 42);

        const p1 = view.promise;
        expect(p1).toBe(source.promise);
        await vi.advanceTimersByTimeAsync(10);
        await p1;

        const refreshPromise = view.refresh();
        await vi.advanceTimersByTimeAsync(10);
        const result = await refreshPromise;

        expect(factory).toHaveBeenCalledTimes(2);
        expect(result).toBe(2);
        expect(source.currentValue).toBe(2);
    });
});
