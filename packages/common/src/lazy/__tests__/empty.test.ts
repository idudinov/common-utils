
import { emptyLazyPromise } from '../empty.js';
import type { ILazyPromise } from '../types.js';

describe('emptyLazyPromise', () => {

    it('reports a settled-empty state for every member', () => {
        const lazy = emptyLazyPromise<string>();

        expect(lazy.isLoading).toBe(false);
        expect(lazy.pendingState).toBeNull();
        expect(lazy.hasValue).toBe(false);
        expect(lazy.error).toBeNull();
        expect(lazy.value).toBeUndefined();
        expect(lazy.currentValue).toBeUndefined();
        expect(lazy.hasResolvedValue()).toBe(false);
    });

    it('reports the given initial value', () => {
        const lazy = emptyLazyPromise<string, string>('initial');

        expect(lazy.value).toBe('initial');
        expect(lazy.currentValue).toBe('initial');
        expect(lazy.hasValue).toBe(false);
    });

    it('resolves promise/refresh() to initial and flips nothing', async () => {
        const lazy = emptyLazyPromise<string, string>('initial');

        await expect(lazy.promise).resolves.toBe('initial');
        await expect(lazy.refresh()).resolves.toBe('initial');

        expect(lazy.isLoading).toBe(false);
        expect(lazy.hasValue).toBe(false);
        expect(lazy.error).toBeNull();
    });

    it('type-checks as ILazyPromise<T, TInitial>', () => {
        const lazy: ILazyPromise<string, 'initial'> = emptyLazyPromise<string, 'initial'>('initial');

        expect(lazy).toBeDefined();
    });
});
