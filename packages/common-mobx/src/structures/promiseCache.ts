import { observable, makeObservable, action } from 'mobx';
import { PromiseCache } from '@zajno/common/structures/promiseCache';
import type { PromiseCacheFetcher, PromiseCacheKeyAdapter, PromiseCacheKeyParser } from '@zajno/common/structures/promiseCache';
import { NumberModel } from '../viewModels/NumberModel.js';
import type { IMapModel, IValueModel } from '@zajno/common/models/types';

export {
    DEFAULT_LOADING_STATE,
} from '@zajno/common/structures/promiseCache';

export type {
    InvalidationConfig,
    InvalidationCallback,
    ErrorCallback,
    PromiseCacheFetcher,
    PromiseCacheKeyAdapter,
    PromiseCacheKeyParser,
    LoadingStateStrategy,
    PendingLoadState,
} from '@zajno/common/structures/promiseCache';

export class PromiseCacheObservable<T, K = string, TInitial extends T | undefined = undefined> extends PromiseCache<T, K, TInitial> {

    private _observeItems = false;

    constructor(
        fetcher: PromiseCacheFetcher<T, K>,
        keyAdapter?: PromiseCacheKeyAdapter<K>,
        keyParser?: PromiseCacheKeyParser<K>,
        observeItems = false,
    ) {
        super(fetcher, keyAdapter, keyParser);

        makeObservable<
            PromiseCacheObservable<T, K, TInitial>,
            | 'setStatus'
            | 'setPromise'
            | 'onBeforeFetch'
            | 'storeResult'
            | 'onFetchComplete'
            | 'onFetchSuperseded'
            | 'onFetchCancelled'
            | '_deleteKey'
            | 'clear'
            | 'sanitize'
            | '_loadingStrategy'
        >(this, {
            setStatus: action,
            setPromise: action,
            onBeforeFetch: action,
            storeResult: action,
            onFetchComplete: action,
            onFetchSuperseded: action,
            onFetchCancelled: action,
            _deleteKey: action,
            clear: action,
            sanitize: action,
            _loadingStrategy: observable.ref,
            useLoadingState: action,
        });

        this._observeItems = observeItems;
    }

    useObserveItems(observeItems: boolean) {
        this._observeItems = observeItems;
        return this;
    }

    protected pure_createLoadingCount(): IValueModel<number> {
        return new NumberModel();
    }

    protected pure_createMap<TK, TV>(): IMapModel<TK, TV> {
        return observable.map<TK, TV>(undefined, { deep: false });
    }

    /** @override */
    protected prepareResult(res: T) {
        return this._observeItems ? observable.object(res) : res;
    }
}
