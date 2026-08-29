import { Getter } from '../types/getter.js';
import { DEFAULT_LOADING_STATE, type ILazyPromise, type IResolvedLazyPromise, type LoadingStateStrategy, type PendingLoadState } from './types.js';

/** The `isLoading` report for a pending state: `primary` wins, then `secondary`, then the default. */
export function deriveIsLoading(pending: PendingLoadState, primary?: LoadingStateStrategy, secondary?: LoadingStateStrategy): boolean {
    const primaryValue = primary?.[pending];
    if (primaryValue !== undefined) {
        return primaryValue;
    }
    const secondaryValue = secondary?.[pending];
    if (secondaryValue !== undefined) {
        return secondaryValue;
    }
    return DEFAULT_LOADING_STATE[pending];
}

/** The `isLoading` report for a pending state under `strategy`, or `fallback` when idle or the state is unnamed. */
export function resolveLoading(
    pending: PendingLoadState | null,
    strategy: LoadingStateStrategy,
    fallback: Getter<boolean | null>,
): boolean | null {
    const value = pending != null ? strategy[pending] : undefined;
    return value !== undefined ? value : Getter.toValue(fallback);
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
    const fallbackIsLoading = () => source.isLoading;

    const view: ILazyPromise<T, TI> = {
        get value() { return source.value; },
        get currentValue() { return source.currentValue; },
        get hasValue() { return source.hasValue; },
        get error() { return source.error; },
        get pendingState() { return source.pendingState; },
        get isLoading() {
            return resolveLoading(source.pendingState, strategy, fallbackIsLoading);
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
