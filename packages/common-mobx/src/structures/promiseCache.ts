import type { PromiseCacheFetcher } from '@zajno/common/structures/promiseCache';
import { PromiseCache } from '@zajno/common/structures/promiseCache';
import { mobxStorageProvider, toObservableValue } from '../storage.js';

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

export { mobxStorageProvider } from '../storage.js';

export class PromiseCacheObservable<T, TKey extends string = string, TInitial extends T | undefined = undefined> extends PromiseCache<T, TKey, TInitial> {

    private _observeItems = false;

    constructor(
        fetcher: PromiseCacheFetcher<T, TKey>,
        observeItems = false,
    ) {
        super(fetcher, {
            storage: mobxStorageProvider,
            prepareValue: value => (this._observeItems ? toObservableValue(value, true) : value),
        });

        this._observeItems = observeItems;
    }

    useObserveItems(observeItems: boolean) {
        this._observeItems = observeItems;
        return this;
    }
}
