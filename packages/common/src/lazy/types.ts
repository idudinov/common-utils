import type { IResettableModel } from '../models/types.js';

/** Kinds of in-flight load — the only states whose `isLoading` report is overridable. */
export type PendingLoadState = 'loading' | 'revalidating' | 'refreshing';

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
     * Returns true if a value of type `T` has been successfully loaded (no error).
     *
     * When `true`, `value` is guaranteed to be `T` (not `TInitial` or an error fallback).
     * When `false`, `value` may be `TInitial`, `undefined`, or a stale value from a previous successful load.
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
     * Returns loading state: `true` = loading with nothing usable to show (by default), `false` = settled
     * or a background re-fetch is in flight, `null` = never started. Does not trigger loading.
     */
    readonly isLoading: boolean | null;

    /** The kind of load currently in flight, or null when idle/settled. */
    readonly pendingState: PendingLoadState | null;

    /**
     * Returns the promise for the value, triggering loading if not started.
     *
     * On error, resolves to the current value (stale or initial) instead of rejecting.
     */
    readonly promise: Promise<T | TInitial>;

    /**
     * Re-executes the factory to get fresh data. If concurrent refreshes occur, the latest wins.
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
     * Manually sets the value and marks loading as complete.
     * Useful for cache synchronization and manual state updates.
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

/**
 * Extension for {@link LazyPromise} instances, applied via `extend()`.
 *
 * @template T - Value type the extension is compatible with (use `any` for universal extensions)
 * @template TExtShape - Additional properties/methods added to the instance
 *
 * @example
 * ```typescript
 * // Universal logging extension
 * const loggingExtension: ILazyPromiseExtension<any> = {
 *   overrideFactory: (original) => async (refreshing) => {
 *     console.log('Loading...');
 *     return await original(refreshing);
 *   }
 * };
 * ```
 */
export interface ILazyPromiseExtension<T = any, TExtShape extends object = object> {

  /**
   * Augment the instance with additional properties/methods.
   *
   * @param previous - The {@link IControllableLazyPromise} instance being extended
   * @returns The instance with additional shape
   */
  extendShape?: <TInitial extends T | undefined = undefined>(
    previous: IControllableLazyPromise<T, TInitial>
  ) => IControllableLazyPromise<T, TInitial> & TExtShape;

  /**
   * Wrap or replace the factory function.
   *
   * @param original - The original factory function
   * @param target - The LazyPromise instance being extended
   * @returns A new factory function
   */
  overrideFactory?: <TInitial extends T | undefined = undefined>(
    original: LazyFactory<T>,
    target: ILazyPromise<T, TInitial> & TExtShape
  ) => LazyFactory<T>;

  /**
   * Cleanup function called when the LazyPromise is disposed.
   * Use for cleaning up resources (timers, subscriptions, listeners).
   * Executes in reverse order: newest extension first, oldest last.
   *
   * @param instance - The extended LazyPromise instance being disposed
   *
   * @example
   * ```typescript
   * const intervalExtension: ILazyPromiseExtension<any, { stopTimer: () => void }> = {
   *   extendShape: (instance) => {
   *     let intervalId: NodeJS.Timeout | null = null;
   *     return Object.assign(instance, {
   *       stopTimer: () => { if (intervalId) clearInterval(intervalId); }
   *     });
   *   },
   *   dispose: (instance) => instance.stopTimer()
   * };
   * ```
   */
  dispose?: (instance: ILazyPromise<T, any> & TExtShape) => void;
}
