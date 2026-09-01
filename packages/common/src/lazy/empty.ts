import type { ILazyPromise, IResolvedLazyPromise } from './types.js';

/**
 * A settled {@link ILazyPromise} that never loads: always reports `initial` (or `undefined`),
 * and `refresh()` is a no-op that resolves to the same value.
 */
export function emptyLazyPromise<T, TInitial extends T | undefined = undefined>(initial?: TInitial): ILazyPromise<T, TInitial> {
    const resolved = Promise.resolve(initial as T | TInitial);

    return {
        isLoading: false,
        pendingState: null,
        hasValue: false,
        error: null,
        value: initial as T | TInitial,
        currentValue: initial,
        promise: resolved,
        refresh: () => resolved,
        hasResolvedValue(): this is IResolvedLazyPromise<T, TInitial> {
            return false;
        },
    };
}
