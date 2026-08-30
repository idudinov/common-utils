import type { ILazyPromise, IResolvedLazyPromise } from '../../lazy/types.js';
import type { IPromiseCache } from './types.js';

/**
 * {@link ILazyPromise} handle bound to an {@link IPromiseCache} by key.
 */
export class PromiseCacheLazyHandle<T, TInitial extends T | undefined = undefined> implements ILazyPromise<T, TInitial> {

    constructor(
        protected readonly cache: IPromiseCache<T, string, TInitial>,
        protected readonly key: string,
    ) {}

    get value() { return this.cache.getCurrent(this.key, true); }
    get currentValue() { return this.cache.getCurrent(this.key, false); }
    get hasValue() { return this.cache.getHasValue(this.key); }
    get error() { return this.cache.getLastError(this.key); }
    get isLoading() { return this.cache.getIsLoading(this.key); }
    get pendingState() { return this.cache.getPendingState(this.key); }
    get promise() { return this.cache.get(this.key); }

    refresh() {
        return this.cache.refresh(this.key);
    }

    hasResolvedValue(): this is IResolvedLazyPromise<T, TInitial> {
        return this.hasValue;
    }
}
