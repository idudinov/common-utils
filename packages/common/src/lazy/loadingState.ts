import { DEFAULT_LOADING_STATE, type ILazyPromise, type LoadingStateStrategy, type PendingLoadState } from './types.js';
import { LazyPromiseView } from './view.js';

/**
 * Single loading-state policy module.
 *
 * A {@link PendingLoadState} classifies an in-flight load. A {@link LoadingStateStrategy} maps a
 * pending kind to the reported `isLoading`. A kind unnamed in the strategy falls through to a
 * caller-chosen fallback: an instance's own strategy falls back to the built-in defaults
 * ({@link DEFAULT_LOADING_STATE}), a view falls back to its source's report.
 */

/** Resolves `strategy[pending]`, falling back to `fallback()` when that entry is `undefined`. */
export function resolveIsLoading<F extends boolean | null>(
    pending: PendingLoadState,
    strategy: LoadingStateStrategy | undefined,
    fallback: () => F,
): boolean | F {
    const value = strategy?.[pending];
    return value !== undefined ? value : fallback();
}

/** The `isLoading` report for a pending state under `strategy`, or the default when unnamed. */
export function deriveIsLoading(pending: PendingLoadState, strategy?: LoadingStateStrategy): boolean {
    return resolveIsLoading(pending, strategy, () => DEFAULT_LOADING_STATE[pending]);
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
export class LoadingStateView<T, TI extends T | undefined = undefined> extends LazyPromiseView<T, TI> {

    constructor(
        source: ILazyPromise<T, TI>,
        private readonly _strategy: LoadingStateStrategy,
    ) {
        super(source);
    }

    get isLoading() {
        const pending = this._source.pendingState;
        return pending != null
            ? resolveIsLoading(pending, this._strategy, () => this._source.isLoading)
            : this._source.isLoading;
    }
}

/** Creates a read-only fork of `source` that reports `isLoading` per `strategy`. */
export function viewLoadingState<T, TI extends T | undefined = undefined>(
    source: ILazyPromise<T, TI>,
    strategy: LoadingStateStrategy,
): ILazyPromise<T, TI> {
    return new LoadingStateView<T, TI>(source, strategy);
}
