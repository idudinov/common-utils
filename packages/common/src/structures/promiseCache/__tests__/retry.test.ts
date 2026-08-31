
import { createRetryExtension, PromiseCache } from '../index.js';

describe('PromiseCache retry extension', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('resolves without surfacing an error when the fetcher fails twice then succeeds', async () => {
        let calls = 0;
        const fetcher = vi.fn(async (key: string) => {
            calls++;
            if (calls < 3) {
                throw new Error('fail');
            }
            return key;
        });

        const cache = new PromiseCache<string>(fetcher).extend(createRetryExtension());

        const promise = cache.get('a');
        await vi.runAllTimersAsync();

        await expect(promise).resolves.toBe('a');
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(cache.getLastError('a')).toBeNull();
    });

    test('surfaces the error through getLastError once retries are exhausted', async () => {
        const error = new Error('always fails');
        const fetcher = vi.fn(async () => {
            throw error;
        });

        const cache = new PromiseCache<string>(fetcher).extend(createRetryExtension({ retries: 1 }));

        const promise = cache.get('a');
        await vi.runAllTimersAsync();
        await promise;

        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(cache.getLastError('a')).toBe(error);
    });
});
