import type { IControllableLazyPromise, ILazyPromise, LazyFactory } from '../types.js';

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
