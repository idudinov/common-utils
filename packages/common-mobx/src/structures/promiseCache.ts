import type { IValueModel } from '@zajno/common/models/types';
import type { PromiseCacheFetcher, PromiseCacheStorageProvider } from '@zajno/common/structures/promiseCache';
import { PromiseCache } from '@zajno/common/structures/promiseCache';
import { observable, runInAction } from 'mobx';
import { ValueModel } from '../viewModels/ValueModel.js';

export {
    DEFAULT_LOADING_STATE,
} from '@zajno/common/structures/promiseCache';

export type {
    ErrorCallback,
    InvalidationCallback,
    InvalidationConfig,
    LoadingStateStrategy,
    PendingLoadState,
    PromiseCacheFetcher,
    PromiseCacheStorageProvider,
} from '@zajno/common/structures/promiseCache';

/**
 * Storage provider backing {@link PromiseCacheObservable}: bare mobx-observable maps and value models.
 * Every mutation runs inside `transaction` (wired to `runInAction`) by the core cache — an unwrapped
 * write is a bug in the core, not something this provider papers over with its own action wrapping.
 */
export const mobxStorageProvider: PromiseCacheStorageProvider = {
    createMap: <K, V>() => observable.map<K, V>(undefined, { deep: false }),
    createValue: <V>(initial: V) => new ValueModel<V>(initial) as IValueModel<V>,
    transaction: fn => runInAction(fn),
};

export class PromiseCacheObservable<T, TKey extends string = string, TInitial extends T | undefined = undefined> extends PromiseCache<T, TKey, TInitial> {

    private _observeItems = false;

    constructor(
        fetcher: PromiseCacheFetcher<T, TKey>,
        observeItems = false,
    ) {
        super(fetcher, {
            storage: mobxStorageProvider,
            prepareValue: value => (this._observeItems ? observable.object(value) : value),
        });

        this._observeItems = observeItems;
    }

    useObserveItems(observeItems: boolean) {
        this._observeItems = observeItems;
        return this;
    }
}
