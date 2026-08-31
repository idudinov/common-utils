import { setTimeoutAsync } from '@zajno/common/async/timeout';
import { LazyPromise } from '@zajno/common/lazy/promise';
import { reaction } from 'mobx';

import { LazyPromiseObservable } from '../observable.js';

describe('LazyPromise', () => {

    it('observable', async () => {
        const VAL = 'abc';
        const l = new LazyPromiseObservable(() => setTimeoutAsync(200).then(() => VAL));

        expect(l.hasValue).toBe(false);
        expect(l.isLoading).toBeNull();

        expect(l.value).toBeUndefined();
        expect(l.isLoading).toBe(true);
        expect(l.promise).not.toBeNull();

        const listener = vi.fn();
        const clean = reaction(() => l.value, vv => listener(vv), { fireImmediately: true });

        expect(listener).toHaveBeenCalledWith(undefined);

        await expect(l.promise).resolves.not.toThrow();

        expect(listener).toHaveBeenCalledWith(VAL);

        expect(l.hasValue).toBe(true);
        expect(l.isLoading).toBe(false);
        expect(l.value).toBe(VAL);

        clean();
    });

    it('error is observable', async () => {
        let shouldFail = true;
        const l = new LazyPromiseObservable<string>(async () => {
            await setTimeoutAsync(50);
            if (shouldFail) {
                throw new Error('Test error');
            }
            return 'success';
        });

        const errorListener = vi.fn();
        const cleanError = reaction(() => l.error, err => errorListener(err), { fireImmediately: true });

        expect(errorListener).toHaveBeenCalledWith(null);
        expect(l.error).toBeNull();

        errorListener.mockClear();

        expect(l.value).toBeUndefined();
        await l.promise;

        expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
        expect(l.error).toBeInstanceOf(Error);
        expect((l.error as Error).message).toBe('Test error');

        errorListener.mockClear();

        shouldFail = false;
        await l.refresh();

        expect(errorListener).toHaveBeenCalledWith(null);
        expect(l.error).toBeNull();
        expect(l.value).toBe('success');

        cleanError();
    });

    it('error is cleared on reset', async () => {
        const l = new LazyPromiseObservable<string>(async () => {
            await setTimeoutAsync(50);
            throw new Error('Test error');
        });

        const errorListener = vi.fn();
        const cleanError = reaction(() => l.error, err => errorListener(err), { fireImmediately: true });

        expect(errorListener).toHaveBeenCalledWith(null);
        errorListener.mockClear();

        await l.promise;
        expect(l.error).toBeInstanceOf(Error);
        expect((l.error as Error).message).toBe('Test error');
        expect(errorListener).toHaveBeenCalledWith(expect.any(Error));

        errorListener.mockClear();

        l.reset();
        expect(l.error).toBeNull();
        expect(errorListener).toHaveBeenCalledWith(null);

        cleanError();
    });

    it('extension returns LazyPromiseObservable instance', async () => {
        const original = new LazyPromiseObservable(async () => 'hello');

        const logs: string[] = [];
        const extended = original.extend({
            overrideFactory: (factory) => async (refreshing) => {
                logs.push(`loading (refreshing=${refreshing})`);
                const result = await factory(refreshing);
                logs.push(`loaded: ${result}`);
                return result;
            },
        });

        expect(extended).toBeInstanceOf(LazyPromiseObservable);
        expect(extended).toBeInstanceOf(LazyPromise);

        const valueListener = vi.fn();
        const cleanValue = reaction(() => extended.value, val => valueListener(val));

        await extended.promise;
        expect(valueListener).toHaveBeenCalledWith('hello');
        expect(logs).toEqual(['loading (refreshing=false)', 'loaded: hello']);

        cleanValue();
    });

    it('extension with shape preserves MobX observability', async () => {
        const original = new LazyPromiseObservable(async () => 42);

        const extended = original.extend<{ double: () => number | undefined }>({
            extendShape: (instance) => {
                return Object.assign(instance, {
                    double: () => {
                        const val = instance.currentValue;
                        return val !== undefined ? val * 2 : undefined;
                    },
                });
            },
        });

        expect(extended).toBeInstanceOf(LazyPromiseObservable);

        const valueListener = vi.fn();
        const errorListener = vi.fn();

        const cleanValue = reaction(() => extended.value, val => valueListener(val));
        const cleanError = reaction(() => extended.error, err => errorListener(err));

        await extended.promise;
        expect(valueListener).toHaveBeenCalledWith(42);
        expect(extended.double()).toBe(84);

        cleanValue();
        cleanError();
    });

    it('chained extensions preserve LazyPromiseObservable type', async () => {
        const original = new LazyPromiseObservable(async () => 10);

        const logs: string[] = [];
        const withLogging = original.extend({
            overrideFactory: (factory) => async (refreshing) => {
                logs.push('loading');
                return factory(refreshing);
            },
        });

        const withRetry = withLogging.extend({
            overrideFactory: (factory) => async (refreshing) => {
                try {
                    return await factory(refreshing);
                } catch {
                    logs.push('retrying');
                    return factory(refreshing);
                }
            },
        });

        expect(withLogging).toBeInstanceOf(LazyPromiseObservable);
        expect(withRetry).toBeInstanceOf(LazyPromiseObservable);

        const listener = vi.fn();
        const clean = reaction(() => withRetry.value, val => listener(val));

        await withRetry.promise;
        expect(listener).toHaveBeenCalledWith(10);
        expect(logs).toEqual(['loading']);

        clean();
    });

    it('dispose works with extensions', async () => {
        const disposeCalls: string[] = [];

        const lazy = new LazyPromiseObservable<string>(async () => {
            await setTimeoutAsync(50);
            return 'value';
        });

        const extended = lazy.extend({
            overrideFactory: (original) => async (refreshing) => {
                const result = await original(refreshing);
                return result + '-modified';
            },
            dispose: () => {
                disposeCalls.push('extension-disposed');
            },
        });

        const listener = vi.fn();
        const clean = reaction(() => extended.value, val => listener(val), { fireImmediately: true });

        expect(listener).toHaveBeenCalledWith(undefined);
        listener.mockClear();

        await extended.promise;
        expect(extended.value).toBe('value-modified');
        expect(listener).toHaveBeenCalledWith('value-modified');

        clean();

        extended.dispose();

        expect(disposeCalls).toEqual(['extension-disposed']);
        expect(extended.currentValue).toBeUndefined();
        expect(extended.hasValue).toBe(false);
        expect(extended.isLoading).toBeNull();
    });

    it('preserves type with extensions', async () => {
        const lazy = new LazyPromiseObservable<number>(async () => 42);

        const disposeCalls: string[] = [];

        const extended = lazy.extend({
            dispose: () => {
                disposeCalls.push('disposed');
            },
        });

        expect(extended).toBeInstanceOf(LazyPromiseObservable);
        expect(extended).toBeInstanceOf(LazyPromise);

        const listener = vi.fn();
        const clean = reaction(() => extended.value, val => listener(val));

        await extended.promise;
        expect(extended.value).toBe(42);

        clean();

        extended.dispose();
        expect(disposeCalls).toEqual(['disposed']);
    });
});
