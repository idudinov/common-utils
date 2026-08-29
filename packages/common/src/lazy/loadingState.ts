import type { ILazyPromise, IResolvedLazyPromise, LoadingStateStrategy, PendingLoadState } from './types.js';

/** Table lookup: the `isLoading` report for a pending state under a (fully-populated) strategy map. */
export function deriveIsLoading(pending: PendingLoadState, strategy: Record<PendingLoadState, boolean | null>): boolean | null {
    return strategy[pending];
}

/**
 * Creates a read-only, presentation-local fork of `source` that reports `isLoading` per `strategy`.
 *
 * Everything but `isLoading` forwards to `source` unchanged, so the fork shares lifecycle with it —
 * loads/refreshes triggered through the view happen on `source` and are visible to every other consumer.
 *
 * Precedence: pending states named in `strategy` use `strategy`'s value; states left unnamed fall
 * through to `source.isLoading` (which already reflects the source's own instance-level strategy),
 * not to the library defaults.
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
            const pending = source.pendingState;
            if (pending == null) {
                return source.isLoading;
            }
            const override = strategy[pending];
            return override !== undefined ? override : source.isLoading;
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
