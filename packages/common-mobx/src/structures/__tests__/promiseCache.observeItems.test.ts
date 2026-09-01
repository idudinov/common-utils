import { Disposer } from '@zajno/common/functions/disposer';
import { isObservable, reaction, runInAction } from 'mobx';
import { PromiseCacheObservable } from '../promiseCache.js';

describe('PromiseCache observable', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('inner observable', async () => {
        const cache = new PromiseCacheObservable(
            async (id: string) => ({ id }),
        ).useObserveItems(true);

        const handler = vi.fn();
        const checkHandler = (res: any) => {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(res);

            handler.mockClear();
        };

        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getCurrent('1', false)?.id,
                v => handler(v),
                { fireImmediately: true },
            ),
        );

        checkHandler(undefined);

        await expect(cache.getLazy('1').promise).resolves.toStrictEqual({ id: '1' });

        checkHandler('1');

        const item = cache.getCurrent('1', false);
        expect(item).toBeDefined();

        runInAction(() => {
            item!.id = '2';
        });

        checkHandler('2');

        disposer.dispose();
    });

    it('re-setting an already-observable item does not throw', async () => {
        const cache = new PromiseCacheObservable(
            async (id: string) => ({ id }),
            true,
        );

        await cache.get('a');

        const current = cache.getCurrent('a', false);
        expect(() => cache.set('a', current!)).not.toThrow();
        expect(isObservable(cache.getCurrent('a', false))).toBe(true);
    });
});
