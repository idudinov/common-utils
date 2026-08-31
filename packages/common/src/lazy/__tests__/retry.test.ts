
import { createRetryExtension } from '../extensions/retry.js';
import { LazyPromise } from '../promise.js';

describe('createRetryExtension', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves without surfacing an error when the factory fails twice then succeeds', async () => {
        let calls = 0;
        const factory = vi.fn(async () => {
            calls++;
            if (calls < 3) {
                throw new Error('fail');
            }
            return 'value';
        });

        const lazy = new LazyPromise<string>(factory).extend(createRetryExtension());

        const promise = lazy.promise;
        await vi.runAllTimersAsync();

        await expect(promise).resolves.toBe('value');
        expect(factory).toHaveBeenCalledTimes(3);
        expect(lazy.error).toBeNull();
    });

    it('surfaces the error through lazy.error once retries are exhausted', async () => {
        const error = new Error('always fails');
        const factory = vi.fn(async () => {
            throw error;
        });

        const lazy = new LazyPromise<string>(factory).extend(createRetryExtension({ retries: 1 }));

        const promise = lazy.promise;
        await vi.runAllTimersAsync();
        await promise;

        expect(factory).toHaveBeenCalledTimes(2);
        expect(lazy.error).toBe(error);
    });
});
