
import { LoggersManager } from '../../../logger/index.js';
import { random } from '../../../math/index.js';
import { createBatchingExtension, PromiseCache } from '../index.js';
import { delayedValue, delayedError } from './helpers.js';
import { describe, beforeEach, afterEach, test } from 'vitest';


describe('PromiseCache', () => {

    const { createLogger } = new LoggersManager().expose();

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('hard load', async () => {
        const COUNT = 1000;
        const TEST_ID = '123';
        const TEST_OBJ = { HELLO: 'WORLD' };

        const loaderFn = vi.fn();

        const cache = new PromiseCache(async _id => {
            loaderFn();
            await delayedValue(200, undefined);
            return TEST_OBJ;
        });

        expect(cache.loadingCount).toBe(0);

        // Trigger the first fetch
        void cache.get(TEST_ID);
        expect(loaderFn).toHaveBeenCalledTimes(1);

        let loadingCount = 0;
        for (let i = 0; i < COUNT; ++i) {
            const lazy = cache.getLazy(TEST_ID);
            if (!lazy.currentValue && lazy.isLoading) {
                ++loadingCount;
            }
        }

        expect(loadingCount).toBe(COUNT);

        const promise = cache.getLazy(TEST_ID).promise;
        await vi.advanceTimersByTimeAsync(200);
        await expect(promise).resolves.toBe(TEST_OBJ);
    });

    test('infrastructure', async () => {
        const loaderFn = vi.fn();
        const TEST_OBJ = { HELLO: 'WORLD' };

        const getRes = (id: string) => ({ ...TEST_OBJ, id });

        const fetcher = async (id: string) => {
            loaderFn();
            await delayedValue(200, undefined);
            return getRes(id);
        };

        const cache = new PromiseCache(fetcher);

        const p1 = cache.get('123');
        await vi.advanceTimersByTimeAsync(200);
        await expect(p1).resolves.toStrictEqual(getRes('123'));
        expect(loaderFn).toHaveBeenCalledTimes(1);

        expect(cache.keys()).toStrictEqual(['123']);
        expect(Array.from(cache.keys(true))).toStrictEqual(['123']);
        cache.delete('123');
        expect(cache.keys()).toStrictEqual([]);

        loaderFn.mockClear();

        const batchLoaderFn = vi.fn();
        const batchLoader = async (ids: string[]) => {
            batchLoaderFn();
            await delayedValue(100, undefined);
            return ids.map(getRes);
        };

        cache.extend(createBatchingExtension(batchLoader));

        const filler = new Array<string>(5).fill('0').map((_, i) => i.toString());

        const results = Promise.all(
            filler.map(async (id, i) => {
                await delayedValue(10 * i, undefined);
                return cache.get(id);
            }),
        );

        expect(loaderFn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(400);

        await expect(results).resolves.toStrictEqual(
            filler.map(getRes),
        );

        filler.forEach(id => {
            expect(cache.hasKey(id)).toBe(true);
            expect(cache.getCurrent(id)).toStrictEqual(getRes(id));
        });

        expect(batchLoaderFn).toHaveBeenCalledTimes(1);

        expect(cache.getCurrent('1')).toStrictEqual(getRes('1'));

        expect(cache.keys()).toStrictEqual(filler);

        cache.delete('1');

        expect(cache.hasKey('1')).toBe(false);

        cache.set('1', getRes('1'));
        expect(cache.hasKey('1')).toBe(true);

        const lazy = cache.getLazy('1');
        expect(lazy.currentValue).not.toBeUndefined();
        expect(lazy.isLoading).toBe(false); // status settled by set()
        await expect(lazy.promise).resolves.toStrictEqual(getRes('1'));
    });

    test('fetching fails', async () => {
        const fetcher = async (_id: string) => delayedError(100, new Error('Fetch failed')) as Promise<number>;

        const cache = new PromiseCache<number>(fetcher)
            .setLoggerFactory(createLogger, '')
            .extend(createBatchingExtension(async (_keys: string[]) => delayedError(100, new Error('Batch fetch failed'))));

        const p = Promise.all([cache.get('1'), cache.get('2')]);
        await vi.advanceTimersByTimeAsync(500);
        await expect(p).resolves.toStrictEqual([undefined, undefined]);

        // Without batching, a direct fetch failure resolves the same way
        const plainCache = new PromiseCache<number>(fetcher).setLoggerFactory(createLogger, '');
        const p2 = plainCache.get('3');
        await vi.advanceTimersByTimeAsync(100);
        await expect(p2).resolves.toBeUndefined();
    });

    test('batching fails', async () => {
        const loaderFn = vi.fn();
        const TEST_OBJ = { HELLO: 'WORLD' };

        const getRes = (id: string) => ({ ...TEST_OBJ, id });

        const fetcher = async (id: string) => {
            loaderFn();
            return delayedValue(200, getRes(id));
        };

        const cache = new PromiseCache(fetcher);

        const batchError = new Error('Batching failed in test');

        const batchLoaderFn = vi.fn();
        const batchLoader = async (_ids: string[]) => {
            batchLoaderFn();
            return delayedError(100, batchError);
        };

        cache.extend(createBatchingExtension(batchLoader));

        const filler = new Array<string>(5).fill('0').map((_, i) => i.toString());

        const results = Promise.all(
            filler.map(async (id, i) => {
                await delayedValue(10 * i, undefined);
                return cache.get(id);
            }),
        );

        await vi.advanceTimersByTimeAsync(600);

        await expect(results).resolves.toStrictEqual(
            filler.map(getRes),
        );

        // Batch call fails once; every key falls back to the individual fetcher
        expect(batchLoaderFn).toHaveBeenCalledTimes(1);
        expect(loaderFn).toHaveBeenCalledTimes(5);
    });

    test('continuos batching', async () => {
        const getRes = (id: string) => ({ id });

        const fetcher = vi.fn(async (id: string) => {
            return delayedValue(10, getRes(id));
        });

        const cache = new PromiseCache(fetcher);

        const batchLoader = vi.fn(async (ids: string[]) => {
            return delayedValue(50, ids.map(getRes));
        });

        cache.extend(createBatchingExtension(batchLoader, 50));

        const doRequests = (base = 1, delay = 10) => {
            const ids = Array.from({ length: 10 }).map((_, i) => (i + base).toString());

            const results = Promise.all(
                ids.map(async id => {
                    await delayedValue(delay, undefined);
                    return cache.get(id);
                }),
            );

            return { ids, results };
        };

        const { ids: ids1, results: results1 } = doRequests(1);

        await vi.advanceTimersByTimeAsync(210);

        const { ids: ids2, results: results2 } = doRequests(6);

        await vi.advanceTimersByTimeAsync(210);

        await expect(results1).resolves.toStrictEqual(ids1.map(getRes));
        await expect(results2).resolves.toStrictEqual(ids2.map(getRes));

        expect(batchLoader).toHaveBeenCalledTimes(2);
        expect(fetcher).toHaveBeenCalledTimes(0);
    });

    test('clears', async () => {
        const cache = new PromiseCache<number>(
            async id => delayedValue(200, Number(id)),
        ).setLoggerFactory(createLogger, 'test');

        expect(cache.hasKey('1')).toBe(false);

        const p1 = cache.get('1');

        await vi.advanceTimersByTimeAsync(50);

        expect(cache.hasKey('1')).toBe(true);

        cache.clear();

        expect(cache.hasKey('1')).toBe(false);

        await vi.advanceTimersByTimeAsync(200);
        await expect(p1).resolves.toBe(1);

        expect(cache.getCurrent('1', false)).toBeUndefined();
    });

    test('auto-invalidation', async () => {
        const generator = vi.fn(() => random(0, 10000));

        const cache = new PromiseCache<string>(
            async id => delayedValue(50, `${id}_${generator()}`),
        ).useInvalidation({ expirationMs: 100 });

        const checkGenerator = (times: number) => {
            expect(generator).toHaveBeenCalledTimes(times);
            generator.mockClear();
        };

        const p1 = cache.get('1');
        await vi.advanceTimersByTimeAsync(50);
        await expect(p1).resolves.toBeTruthy();
        checkGenerator(1);

        const p2 = cache.get('1');
        await expect(p2).resolves.toBeTruthy();
        checkGenerator(0);

        await vi.advanceTimersByTimeAsync(50);

        expect(cache.getCurrent('1')).toBeTruthy();

        await vi.advanceTimersByTimeAsync(51);

        // Stale value is always kept (stale-while-revalidate)
        const staleValue = cache.getCurrent('1', false);
        expect(staleValue).toBeTruthy();
        expect(cache.getIsValid('1')).toBe(false); // but it's invalidated

        const p3 = cache.get('1');
        await vi.advanceTimersByTimeAsync(50);
        await expect(p3).resolves.toBeTruthy();
        checkGenerator(1);

        cache.useInvalidation({ expirationMs: 100 });

        const previous = cache.getCurrent('1');
        expect(previous).toBeTruthy();

        checkGenerator(0);

        await vi.advanceTimersByTimeAsync(105);

        expect(cache.getCurrent('1', false)).toBe(previous);
        expect(cache.getLazy('1').isLoading).toBe(false); // expired but settled — stale value still served

        const nextPromise = cache.get('1');
        await vi.advanceTimersByTimeAsync(50);
        await expect(nextPromise).resolves.toBeTruthy();
        await expect(nextPromise).resolves.not.toBe(previous);

        checkGenerator(1);
    });

    describe('null-key guard', () => {
        test('get() throws on null/undefined key', async () => {
            const fetcher = vi.fn(async (id: string) => id);
            const cache = new PromiseCache<string>(fetcher);

            expect(() => cache.get(undefined as unknown as string)).toThrow();
            expect(() => cache.get(null as unknown as string)).toThrow();
            expect(fetcher).not.toHaveBeenCalled();
            expect(cache.hasKey('undefined')).toBe(false);
        });

        test('refresh()/set()/getLazy() throw on null/undefined key', () => {
            const cache = new PromiseCache<string>(async id => id);

            expect(() => cache.refresh(undefined as unknown as string)).toThrow();
            expect(() => cache.set(null as unknown as string, 'x')).toThrow();
            expect(() => cache.getLazy(undefined as unknown as string)).toThrow();
        });
    });
});
