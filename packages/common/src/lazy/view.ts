import type { ILazyPromise, IResolvedLazyPromise } from './types.js';

/** Forwards every {@link ILazyPromise} member to `_source`. Subclass to override selected members. */
export abstract class LazyPromiseView<T, TInitial extends T | undefined = undefined> implements ILazyPromise<T, TInitial> {

    constructor(protected readonly _source: ILazyPromise<T, TInitial>) {}

    get value() { return this._source.value; }
    get currentValue() { return this._source.currentValue; }
    get hasValue() { return this._source.hasValue; }
    get error() { return this._source.error; }
    get isLoading() { return this._source.isLoading; }
    get pendingState() { return this._source.pendingState; }
    get promise() { return this._source.promise; }

    refresh() {
        return this._source.refresh();
    }

    hasResolvedValue(): this is IResolvedLazyPromise<T, TInitial> {
        return this.hasValue;
    }
}
