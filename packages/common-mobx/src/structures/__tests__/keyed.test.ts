import { KeyedPromiseCache } from '@zajno/common/structures/promiseCache';
import { reaction } from 'mobx';
import { Disposer } from '@zajno/common/functions/disposer';
import { PromiseCacheObservable } from '../promiseCache.js';

describe('KeyedPromiseCache with a PromiseCacheObservable cacheFactory', () => {

    test('translates ids while the inner cache stays observable', async () => {
        const fetcher = vi.fn(async (id: number) => ({ id, name: `item-${id}` }));

        const cache = new KeyedPromiseCache(fetcher, id => id.toString(), {
            cacheFactory: f => new PromiseCacheObservable(f),
        });

        expect(cache.cache).toBeInstanceOf(PromiseCacheObservable);

        const handler = vi.fn();
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getCurrent(42, false),
                v => handler(v),
                { fireImmediately: true },
            ),
        );

        expect(handler).toHaveBeenCalledWith(undefined);
        handler.mockClear();

        await expect(cache.get(42)).resolves.toEqual({ id: 42, name: 'item-42' });

        expect(handler).toHaveBeenCalledWith({ id: 42, name: 'item-42' });

        disposer.dispose();
    });
});
