import { Getter } from '../types/getter.js';
import type { ILazyPromise, IResolvedLazyPromise } from './types.js';

/**
 * Derives an always-valued {@link ILazyPromise} from a source, running a mapper that also handles `undefined` on every read.
 *
 * `value` and `currentValue` are the override points for memoizing the mapped result.
 * `promise` and `refresh()` resolve through `this.value`, so an override reaches them too.
 */
export class MappedLazyPromiseView<TSource, T, TSourceInitial extends TSource | undefined = undefined>
    implements ILazyPromise<T, T> {

    private readonly _sourceGetter: () => ILazyPromise<TSource, TSourceInitial>;

    /**
     * @param source Evaluated on every access, including inside `promise` and `refresh()`'s
     * continuations — swapping its target mid-refresh resolves against the new source.
     */
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
