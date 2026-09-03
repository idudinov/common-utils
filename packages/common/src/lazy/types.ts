import type { IResettableModel, ValueStorageProvider } from '../models/types.js';
export type * from './extensions/types.js';

/** Kinds of in-flight load — the only states whose `isLoading` report is overridable. */
export type PendingLoadState = 'loading' | 'revalidating' | 'refreshing';

/** Three states: not started (`null`), in progress (`true`), stopped (`false`). */
export type LoadingStates = boolean | null;

/**
 * Per-pending-state override of the reported `isLoading` value.
 * Missing keys fall back to {@link DEFAULT_LOADING_STATE}.
 */
export type LoadingStateStrategy = Partial<Record<PendingLoadState, boolean>>;

/** Default `isLoading` report per pending state: true only when there is nothing usable to show. */
export const DEFAULT_LOADING_STATE: Record<PendingLoadState, boolean> = {
    'loading': true,
    'revalidating': false,
    'refreshing': false,
};

/** Represents a lazily loaded value that initializes on first access. */
export interface ILazy<T> {
    /** Returns current value, triggering loading if not yet loaded. */
    readonly value: T;

    /**
     * Returns whether a value of type `T` has been successfully loaded (no error).
     *
     * When `true`, `value` and `currentValue` hold that loaded `T`.
     * When `false`, they may hold a fallback, be `undefined`, or hold a stale value from a previous successful load.
     *
     * Does not trigger loading.
     */
    readonly hasValue: boolean;

    /** Returns current value or undefined if not loaded. Does not trigger loading. */
    readonly currentValue: T | undefined;

    /** Returns the raw error if loading failed, null otherwise. Does not trigger loading. */
    readonly error: unknown;
}

/** Represents a lazily asynchronously loaded value with promise-based access. */
export interface ILazyPromise<T, TInitial extends T | undefined = undefined> extends ILazy<T | TInitial> {
    /**
     * The current loading state; see {@link LoadingStates}.
     * Does not trigger loading.
     */
    readonly isLoading: LoadingStates;

    /** The kind of load currently in flight, or null when idle/settled. */
    readonly pendingState: PendingLoadState | null;

    /**
     * Returns the promise for the value, triggering loading if not started.
     *
     * On error, resolves to the current value (stale or initial) instead of rejecting.
     */
    readonly promise: Promise<T | TInitial>;

    /**
     * Re-executes the factory to get fresh data.
     * If concurrent refreshes occur, the latest wins.
     * All awaiting promises will resolve to the final refreshed value.
     *
     * On error, resolves to the current value (stale or initial) instead of rejecting.
     *
     * **⚠️ Use sparingly:** Only refresh when explicitly needed for fresh data.
     * Over-use defeats lazy loading and caching benefits.
     *
     * **Valid use cases:**
     * - User-initiated refresh (pull-to-refresh, refresh button)
     * - Cache invalidation after mutation
     * - Time-based refresh with throttling
     * - Error recovery
     *
     * **Avoid:**
     * - Refreshing on every render/mount
     * - Using instead of cache expiration (use `withExpire`)
     * - Calling in loops or high-frequency events without debouncing
     *
     * @returns Promise resolving to the refreshed value, or the current value on error
     */
    refresh(): Promise<T | TInitial>;

    /**
     * Type-narrowing check: returns `true` if the value has been successfully resolved to `T`.
     *
     * When this returns `true`, `value` and `currentValue` are narrowed to `T` (not `TInitial`).
     *
     * @example
     * ```typescript
     * const lazy: ILazyPromise<User> = cache.getLazy('user-1');
     * if (lazy.hasResolvedValue()) {
     *     // lazy.value is `User` here, not `User | undefined`
     *     console.log(lazy.value.name);
     * }
     * ```
     */
    hasResolvedValue(): this is IResolvedLazyPromise<T, TInitial>;
}

/** Narrowed state of ILazyPromise after successful resolution. */
export interface IResolvedLazyPromise<T, TInitial extends T | undefined = undefined> extends ILazyPromise<T, TInitial> {
    readonly value: T;
    readonly currentValue: T;
    readonly hasValue: true;
    readonly error: null;
}

/** Controllable {@link ILazyPromise} with manual state management. */
export interface IControllableLazyPromise<T, TInitial extends T | undefined = undefined>
    extends ILazyPromise<T, TInitial>, IResettableModel {
    /**
     * Manually sets the value, marks loading as complete, and clears any errors.
     *
     * @param value - The value to set
     * @returns The value that was set
     */
    setInstance(value: T): T;
}

/**
 * Factory function that retrieves the value for LazyPromise.
 *
 * @param refreshing - True when called via refresh(), false on initial load
 */
export type LazyFactory<T> = (refreshing?: boolean) => Promise<T>;

/** Constructor options for a lazy promise. */
export type LazyPromiseOptions<T> = {
    /**
     * Supplies the value boxes backing internal state.
     * Defaults to plain boxes.
     */
    storage?: ValueStorageProvider;

    /** Pre-processes a value — resolved by the factory or injected via `setInstance()` — before it is stored. */
    prepareValue?: (value: T) => T;
};
