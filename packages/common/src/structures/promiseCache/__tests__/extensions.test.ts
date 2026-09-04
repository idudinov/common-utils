
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { extendObject } from '../../extendObject.js';
import { PromiseCache } from '../index.js';

describe('PromiseCache extensions', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('overrideFetcher wraps in the order extend() was called — last extend() is outermost', async () => {
        const calls: string[] = [];

        const cache = new PromiseCache<string>(async key => {
            calls.push(`base:${key}`);
            return key;
        })
            .extend({
                overrideFetcher: () => async request => {
                    calls.push('ext1:before');
                    const res = await request.next();
                    calls.push('ext1:after');
                    return res;
                },
            })
            .extend({
                overrideFetcher: () => async request => {
                    calls.push('ext2:before');
                    const res = await request.next();
                    calls.push('ext2:after');
                    return res;
                },
            });

        await expect(cache.get('a')).resolves.toBe('a');

        expect(calls).toEqual(['ext2:before', 'ext1:before', 'base:a', 'ext1:after', 'ext2:after']);
    });

    test('a class-shaped extension with plain-method hooks keeps its own `this`', async () => {
        class CountingExtension {
            count = 0;

            onStored() {
                this.count++;
            }
        }
        const ext = new CountingExtension();

        const cache = new PromiseCache<string>(async key => key).extend(ext);

        await cache.get('a');
        cache.set('b', 'raw');

        expect(ext.count).toBe(2);
    });

    test('extendShape augments the instance and its members are directly usable', () => {
        const cache = new PromiseCache<number>(async () => 1).extend<{ double: (n: number) => number }>({
            extendShape: previous => extendObject(previous, {
                double: { value: (n: number) => n * 2 },
            }),
        });

        expect(cache.double(21)).toBe(42);
        // base members remain intact on the extended instance
        expect(cache.getCurrent('a', false)).toBeUndefined();
    });

    test('onStored fires for fetch success and for set(), with the prepared value', async () => {
        const onStored = vi.fn();

        const cache = new PromiseCache<string>(
            async key => key.toUpperCase(),
            { prepareValue: v => `${v}!` },
        ).extend({ onStored });

        await expect(cache.get('a')).resolves.toBe('A!');
        expect(onStored).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: 'a', value: 'A!', target: cache }));

        cache.set('b', 'raw');
        expect(onStored).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: 'b', value: 'raw!', target: cache }));
        expect(onStored.mock.calls[1][0].context).toBeUndefined();

        expect(onStored).toHaveBeenCalledTimes(2);
    });

    test('onRemoved fires for delete() and sanitize(), not for clear()', async () => {
        const onRemoved = vi.fn();

        const cache = new PromiseCache<string>(async key => key)
            .useInvalidation({ expirationMs: 10 })
            .extend({ onRemoved });

        await cache.get('a');
        cache.delete('a');
        expect(onRemoved).toHaveBeenCalledTimes(1);
        expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ key: 'a', target: cache }));

        await cache.get('b');
        await vi.advanceTimersByTimeAsync(20);
        cache.sanitize();
        expect(onRemoved).toHaveBeenCalledTimes(2);
        expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ key: 'b', target: cache }));

        await cache.get('c');
        cache.clear();
        expect(onRemoved).toHaveBeenCalledTimes(2);
    });

    test('onCleared fires on clear()', async () => {
        const onCleared = vi.fn();

        const cache = new PromiseCache<string>(async key => key).extend({ onCleared });

        await cache.get('a');
        cache.clear();

        expect(onCleared).toHaveBeenCalledTimes(1);
        expect(onCleared).toHaveBeenCalledWith(expect.objectContaining({ target: cache }));
        expect(cache.hasKey('a')).toBe(false);
    });

    test('dispose() runs extension disposers newest-first, then clear()', async () => {
        const order: string[] = [];

        const cache = new PromiseCache<string>(async key => key)
            .extend({ dispose: () => order.push('ext1') })
            .extend({ dispose: () => order.push('ext2') })
            .extend({ onCleared: () => order.push('cleared') });

        await cache.get('a');
        cache.dispose();

        expect(order).toEqual(['ext2', 'ext1', 'cleared']);
        expect(cache.hasKey('a')).toBe(false);
    });

    test('a throwing hook does not break the cache operation or other hooks', async () => {
        const good = vi.fn();
        const error = vi.fn();

        const cache = new PromiseCache<string>(async key => key)
            .setLogger({ log: vi.fn(), warn: vi.fn(), error })
            .extend({ onStored: () => { throw new Error('boom'); } })
            .extend({ onStored: good });

        await expect(cache.get('a')).resolves.toBe('a');

        expect(good).toHaveBeenCalledWith(expect.objectContaining({ key: 'a', value: 'a', target: cache }));
        expect(cache.getCurrent('a', false)).toBe('a');
        expect(error).toHaveBeenCalled();
    });
});
