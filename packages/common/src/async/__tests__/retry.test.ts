
import { withRetry } from '../retry.js';

describe('withRetry', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('succeeds after N failures', async () => {
        const error = new Error('fail');
        let calls = 0;
        const fn = vi.fn(async () => {
            calls++;
            if (calls < 3) {
                throw error;
            }
            return 'ok';
        });

        const promise = withRetry(fn);
        await vi.runAllTimersAsync();

        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('rethrows the last error once retries are exhausted', async () => {
        const errors = [new Error('e1'), new Error('e2'), new Error('e3'), new Error('e4')];
        let calls = 0;
        const fn = vi.fn(async () => {
            throw errors[calls++];
        });

        const promise = withRetry(fn, { retries: 3 });
        const assertion = expect(promise).rejects.toBe(errors[3]);
        await vi.runAllTimersAsync();

        await assertion;
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('skips retrying when errorFilter returns true', async () => {
        const error = new Error('filtered');
        const fn = vi.fn(async () => {
            throw error;
        });

        const promise = withRetry(fn, { errorFilter: () => true });
        const assertion = expect(promise).rejects.toBe(error);
        await vi.runAllTimersAsync();

        await assertion;
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('reports decreasing retriesLeft and doubling delay to onRetry', async () => {
        const error = new Error('fail');
        const fn = vi.fn(async () => {
            throw error;
        });
        const onRetry = vi.fn();

        const promise = withRetry(fn, { retries: 3, delay: 100, backoffMultiplier: 2, onRetry });
        const assertion = expect(promise).rejects.toBe(error);
        await vi.runAllTimersAsync();

        await assertion;
        expect(onRetry.mock.calls).toEqual([
            [error, 3, 100],
            [error, 2, 200],
            [error, 1, 400],
        ]);
    });

    it('does not call onRetry on first-try success', async () => {
        const fn = vi.fn(async () => 'ok');
        const onRetry = vi.fn();

        await expect(withRetry(fn, { onRetry })).resolves.toBe('ok');
        expect(onRetry).not.toHaveBeenCalled();
    });
});
