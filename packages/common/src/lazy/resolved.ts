import type { IResolvedLazyPromise } from './types.js';

/**
 * A settled {@link IResolvedLazyPromise} that never loads.
 * It always reports `value`, and `refresh()` is a no-op that resolves to the same value.
 */
export function resolvedLazyPromise<T>(value: T): IResolvedLazyPromise<T> {
    const resolved = Promise.resolve(value);

    return {
        isLoading: false,
        pendingState: null,
        hasValue: true,
        error: null,
        value,
        currentValue: value,
        promise: resolved,
        refresh: () => resolved,
        hasResolvedValue(): this is IResolvedLazyPromise<T> {
            return true;
        },
    };
}
