import { Getter } from '../types/getter.js';
import type { ILazyPromise, IResolvedLazyPromise } from './types.js';

/**
 * Derives an always-valued {@link ILazyPromise} from a source by running a total mapper on every read.
 * `value` and `currentValue` are the override points for a subclass that wants to memoize the mapped result.
 */
export class MappedLazyPromiseView<TSource, T, TSourceInitial extends TSource | undefined = undefined>
    implements ILazyPromise<T, T> {

    private readonly _sourceGetter: () => ILazyPromise<TSource, TSourceInitial>;

    constructor(
        source: Getter<ILazyPromise<TSource, TSourceInitial>>,
        protected readonly _map: (value: NoInfer<TSource | TSourceInitial> | undefined) => T,
    ) {
        this._sourceGetter = Getter.toFn(source);
    }

    protected get _source() { return this._sourceGetter(); }

    get value(): T { return this._map(this._source.value); }
    get currentValue(): T { return this._map(this._source.currentValue); }

    get hasValue() { return this._source.hasValue; }
    get error() { return this._source.error; }
    get isLoading() { return this._source.isLoading; }
    get pendingState() { return this._source.pendingState; }

    get promise(): Promise<T> { return this._source.promise.then(() => this.value); }

    refresh(): Promise<T> { return this._source.refresh().then(() => this.value); }

    hasResolvedValue(): this is IResolvedLazyPromise<T, T> { return this._source.hasResolvedValue(); }
}
