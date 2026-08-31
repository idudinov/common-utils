import { setTimeoutAsync } from '@zajno/common/async/timeout';
import { autorun, reaction } from 'mobx';

import { LazyPromiseObservable } from '../observable.js';

describe('LazyPromise', () => {

    it('isLoading is observable across transitions under a loading-state strategy', async () => {
        const l = new LazyPromiseObservable(() => setTimeoutAsync(50).then(() => 'value'))
            .withLoadingState({ refreshing: true });

        const seen: (boolean | null)[] = [];
        const clean = reaction(() => l.isLoading, v => seen.push(v), { fireImmediately: true });

        expect(l.value).toBeUndefined();
        await l.promise;
        await l.refresh();

        clean();

        // null (idle) -> true (loading) -> false (resolved) -> true (refreshing, per strategy) -> false (resolved)
        expect(seen).toEqual([null, true, false, true, false]);
    });

    it('error observable on refresh', async () => {
        let counter = 0;
        const l = new LazyPromiseObservable<string>(async () => {
            await setTimeoutAsync(50);
            counter++;
            if (counter === 2) {
                throw new Error('Refresh error');
            }
            return `value-${counter}`;
        });

        const errorListener = vi.fn();
        const valueListener = vi.fn();

        const cleanError = reaction(() => l.error, err => errorListener(err));
        const cleanValue = reaction(() => l.value, val => valueListener(val));

        await l.promise;
        expect(l.value).toBe('value-1');
        expect(l.error).toBeNull();
        expect(errorListener).not.toHaveBeenCalled();

        await l.refresh();
        expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
        expect(l.error).toBeInstanceOf(Error);
        expect((l.error as Error).message).toBe('Refresh error');
        expect(l.value).toBe('value-1');

        errorListener.mockClear();

        await l.refresh();
        expect(errorListener).toHaveBeenCalledWith(null);
        expect(l.error).toBeNull();
        expect(l.value).toBe('value-3');

        cleanError();
        cleanValue();
    });

    it('withLoadingState() applied mid-flight is observed by autorun', async () => {
        const lazy = new LazyPromiseObservable(() => setTimeoutAsync(50).then(() => 'value'));

        const seen: (boolean | null)[] = [];
        const clean = autorun(() => { seen.push(lazy.isLoading); });

        void lazy.promise;
        expect(lazy.isLoading).toBe(true);

        lazy.withLoadingState({ loading: false });

        expect(lazy.isLoading).toBe(false);
        expect(seen.at(-1)).toBe(false);

        clean();

        await lazy.promise;
    });

    it('reacts to isLoading and currentValue through a full load cycle with no makeObservable involved', async () => {
        const lazy = new LazyPromiseObservable(() => setTimeoutAsync(50).then(() => 'value'));

        const seenLoading: (boolean | null)[] = [];
        const seenValues: (string | undefined)[] = [];

        const cleanLoading = autorun(() => { seenLoading.push(lazy.isLoading); });
        const cleanValue = reaction(() => lazy.currentValue, v => seenValues.push(v), { fireImmediately: true });

        await lazy.promise;

        cleanLoading();
        cleanValue();

        expect(seenLoading).toEqual([null, true, false]);
        expect(seenValues).toEqual([undefined, 'value']);
    });
});
