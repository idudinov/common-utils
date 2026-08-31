import { observable, reaction, runInAction, toJS } from 'mobx';
import { SubscribersPromiseCache } from '../subscribersPromiseCache.js';
import { setTimeoutAsync } from '@zajno/common/async/timeout';

type TestItem = {
    hello: string,
};

function createData() {
    const Database: Record<string, TestItem> = observable({
        '123': { hello: 'Hi, 123' },
    });

    const Repository = {
        fetch: (key: string, cb: (value: TestItem) => Promise<void> | void) => {
            return reaction(
                () => Database[key],
                item => {
                    setTimeoutAsync(100).then(() => cb(item));
                },
                { fireImmediately: true, delay: 100 },
            );
        },
    };

    const noOp = () => { /* no-op */ };
    const subscribeFn = vi.fn().mockImplementation(noOp);
    const unsubFn = vi.fn().mockImplementation(noOp);

    const Cache = new SubscribersPromiseCache((key, cb) => {
        subscribeFn(key);
        const unsub = Repository.fetch(key, cb);
        return () => {
            unsubFn();
            unsub();
        };
    });

    return {
        Database,
        Repository,
        Cache,
        subscribeFn,
        unsubFn,
    };
}


describe('ObservingCache works with', () => {
    it('no observing', async () => {
        const { Database, Cache, subscribeFn, unsubFn } = createData();
        try {
            expect(Cache).not.toBeNull();
            expect(subscribeFn).not.toHaveBeenCalled();
            expect(unsubFn).not.toHaveBeenCalled();

            const KEY = '123';

            const lazy = Cache.get(KEY);

            expect(lazy.isLoading).toBeNull();
            const p = lazy.promise;
            expect(lazy.isLoading).toBeTruthy();

            const expectedItem = toJS(Database[KEY]);

            await expect(p).resolves.toStrictEqual(expectedItem);

            expect(lazy.currentValue).toStrictEqual(expectedItem);
            expect(lazy.isLoading).toBeFalsy();

            expect(unsubFn).toHaveBeenCalledTimes(1);

            expect(subscribeFn).toHaveBeenCalledTimes(1);
            expect(subscribeFn).toHaveBeenCalledWith(KEY);

            subscribeFn.mockClear();
            unsubFn.mockClear();

            Database[KEY] = { hello: 'bye' };

            expect(subscribeFn).not.toHaveBeenCalled();
        } finally {
            Cache.dispose();
        }
    });

    it('infinite observing', async () => {
        const { Database, Cache, subscribeFn, unsubFn } = createData();
        try {
            Cache.useObservingStrategy(true);

            const KEY = '123';

            const lazy = Cache.get(KEY);

            expect(lazy.isLoading).toBeNull();
            const p = lazy.promise;
            expect(lazy.isLoading).toBeTruthy();

            const expectedItem = toJS(Database[KEY]);

            await expect(p).resolves.toStrictEqual(expectedItem);

            expect(lazy.currentValue).toStrictEqual(expectedItem);
            expect(lazy.isLoading).toBeFalsy();

            expect(unsubFn).not.toHaveBeenCalled();

            expect(subscribeFn).toHaveBeenCalledTimes(1);
            expect(subscribeFn).toHaveBeenCalledWith(KEY);

            subscribeFn.mockClear();
            unsubFn.mockClear();

            const replaceItem: TestItem = { hello: 'bye' };
            runInAction(() => {
                Database[KEY] = replaceItem;
            });

            expect(subscribeFn).not.toHaveBeenCalled();

            await setTimeoutAsync(300);

            expect(lazy.currentValue).toStrictEqual(replaceItem);
        } finally {
            Cache.dispose();
            expect(unsubFn).toHaveBeenCalledTimes(1);
        }
    });
});

describe('useUpdater', () => {
    it('a subscription update re-setting the current observable value does not throw', async () => {
        let cb!: (val: TestItem) => void;

        const fetcher = vi.fn((_key: string, callback: (val: TestItem) => void) => {
            cb = callback;
            return () => { /* unsub */ };
        });

        const Cache = new SubscribersPromiseCache<TestItem>(fetcher)
            .useUpdater((current, incoming) => Object.assign(current, incoming));

        try {
            const lazy = Cache.get('123');
            const p = lazy.promise;

            // First invocation resolves the initial fetch.
            cb({ hello: 'first' });
            await expect(p).resolves.toStrictEqual({ hello: 'first' });

            // Second invocation is a subscription update: it re-sets the already-observable
            // current value returned by the updater.
            expect(() => cb({ hello: 'second' })).not.toThrow();
            expect(Cache.getCurent('123')).toStrictEqual({ hello: 'second' });
        } finally {
            Cache.dispose();
        }
    });
});
