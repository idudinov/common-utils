import { DEFAULT_LOADING_STATE, type ILazyPromise, type IResolvedLazyPromise, type LoadingStateStrategy, type PendingLoadState } from './types.js';

/** The `isLoading` report for a pending state: the first strategy naming it wins, the default otherwise. */
export function deriveIsLoading(pending: PendingLoadState, ...strategies: (LoadingStateStrategy | undefined)[]): boolean | null {
    for (const strategy of strategies) {
        const value = strategy?.[pending];
        if (value !== undefined) {
            return value;
        }
    }
    return DEFAULT_LOADING_STATE[pending];
}

/** The `isLoading` report for a pending state under `strategy`, or `fallback` when idle or the state is unnamed. */
export function resolveLoading(
    pending: PendingLoadState | null,
    strategy: LoadingStateStrategy,
    fallback: boolean | null | undefined,
): boolean | null | undefined {
    const value = pending != null ? strategy[pending] : undefined;
    return value !== undefined ? value : fallback;
}

/**
 * Creates a read-only fork of `source` that reports `isLoading` per `strategy`.
 * Everything else forwards to `source`, so loads/refreshes are shared with it.
 *
 * Pending states unnamed in `strategy` fall through to `source.isLoading`, not to the defaults.
 */
export function viewLoadingState<T, TI extends T | undefined = undefined>(
    source: ILazyPromise<T, TI>,
    strategy: LoadingStateStrategy,
): ILazyPromise<T, TI> {
    const view: ILazyPromise<T, TI> = {
        get value() { return source.value; },
        get currentValue() { return source.currentValue; },
        get hasValue() { return source.hasValue; },
        get error() { return source.error; },
        get pendingState() { return source.pendingState; },
        get isLoading() {
            return resolveLoading(source.pendingState, strategy, source.isLoading);
        },
        get promise() { return source.promise; },
        refresh() {
            return source.refresh();
        },
        hasResolvedValue(this: ILazyPromise<T, TI>): this is IResolvedLazyPromise<T, TI> {
            return view.hasValue;
        },
    };
    return view;
}
