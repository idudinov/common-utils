import { DEFAULT_LOADING_STATE, type ILazyPromise, type IResolvedLazyPromise, type LoadingStateStrategy, type PendingLoadState } from './types.js';

/** The `isLoading` report for a pending state under `strategy`, or the default when unnamed. */
export function deriveIsLoading(pending: PendingLoadState, strategy?: LoadingStateStrategy): boolean {
    const value = strategy?.[pending];
    return value !== undefined ? value : DEFAULT_LOADING_STATE[pending];
}

/**
 * The pending kind for an explicit `refresh()` call: `'loading'`/`'refreshing'` already in flight keep
 * their classification — a passive `'revalidating'` is escalated to `'refreshing'`, since an explicit
 * refresh() is a stronger signal. Otherwise derived from whether a value already exists.
 */
export function refreshPendingKind(current: PendingLoadState | null, hasValue: boolean): PendingLoadState {
    if (current === 'loading' || current === 'refreshing') {
        return current;
    }
    return hasValue ? 'refreshing' : 'loading';
}

/** The pending kind for a passive load/revalidation (no explicit refresh() involved). */
export function passivePendingKind(hasValue: boolean): PendingLoadState {
    return hasValue ? 'revalidating' : 'loading';
}

/**
 * Read-only fork of an {@link ILazyPromise} reporting `isLoading` per `strategy`.
 * Everything else forwards to `_source`, so loads/refreshes are shared with it.
 *
 * Pending states unnamed in `strategy` fall through to `_source.isLoading`, not to the defaults.
 */
class LoadingStateView<T, TI extends T | undefined = undefined> implements ILazyPromise<T, TI> {

    constructor(
        private readonly _source: ILazyPromise<T, TI>,
        private readonly _strategy: LoadingStateStrategy,
    ) {}

    get value() { return this._source.value; }
    get currentValue() { return this._source.currentValue; }
    get hasValue() { return this._source.hasValue; }
    get error() { return this._source.error; }
    get pendingState() { return this._source.pendingState; }

    get isLoading() {
        const pending = this._source.pendingState;
        const value = pending != null ? this._strategy[pending] : undefined;
        return value !== undefined ? value : this._source.isLoading;
    }

    get promise() { return this._source.promise; }

    refresh() {
        return this._source.refresh();
    }

    hasResolvedValue(): this is IResolvedLazyPromise<T, TI> {
        return this.hasValue;
    }
}

/** Creates a read-only fork of `source` that reports `isLoading` per `strategy`. */
export function viewLoadingState<T, TI extends T | undefined = undefined>(
    source: ILazyPromise<T, TI>,
    strategy: LoadingStateStrategy,
): ILazyPromise<T, TI> {
    return new LoadingStateView<T, TI>(source, strategy);
}
