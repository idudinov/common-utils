import { tryDispose, type IDisposable } from '../functions/disposer.js';
import type { IResettableModel } from '../models/types.js';
import type { IExpireTracker } from '../structures/expire.js';
import { deriveIsLoading, viewLoadingState } from './loadingState.js';
import type {
    IControllableLazyPromise,
    ILazyPromise,
    ILazyPromiseExtension,
    IResolvedLazyPromise,
    LazyFactory,
    LoadingStateStrategy,
    PendingLoadState,
} from './types.js';

/**
 * Granular state, recording facts (pending trigger × last settled outcome):
 * - `null` — idle, never settled
 * - `'resolved'` — settled with a value (factory or `setInstance`)
 * - `'failed'` — settled, first load failed, no value
 * - {@link PendingLoadState} — a load is in flight
 */
type LazyPromiseState = null | 'resolved' | 'failed' | PendingLoadState;

/**
 * Asynchronous lazy-loading container that initializes via a promise-based factory.
 * Handles concurrent operations with "latest wins" semantics: multiple refreshes are automatically
 * coordinated so all awaiting promises receive the final value. Supports extensions for custom behavior.
 */
export class LazyPromise<T, TInitial extends T | undefined = undefined> implements IControllableLazyPromise<T, TInitial>, IDisposable, IResettableModel {

    private _factory: LazyFactory<T>;
    private readonly _initial: TInitial;

    private _instance: T | TInitial;

    private _state: LazyPromiseState = null;

    private _loadingStrategy: LoadingStateStrategy | undefined;

    private _isAsyncStateChange = false;

    private _promise: Promise<T | TInitial> | undefined;
    private _expireTracker: IExpireTracker | undefined;

    // Track the active factory promise to determine "latest wins"
    private _activeFactoryPromise: Promise<T | TInitial> | null = null;
    private _error: unknown = null;

    private _ownDisposer?: () => void;

    constructor(
        factory: LazyFactory<T>,
        initial?: TInitial,
    ) {
        this._factory = factory;
        this._initial = initial as TInitial;

        this._instance = initial as T | TInitial; // as ILazyValue<T, TInitial>;
    }

    /** Current loading state: true = loading, false = loaded, null = not started. Pending states report per {@link withLoadingState}. */
    public get isLoading(): boolean | null {
        const state = this._state;
        if (state === null) {
            return null;
        }
        if (state === 'resolved' || state === 'failed') {
            return false;
        }
        return deriveIsLoading(state, this._loadingStrategy);
    }

    /**
     * Returns true if a value of type `T` has been successfully loaded (no error).
     * Stays `true` while a refresh/revalidation is in flight; use {@link isLoading} to hide stale values.
     */
    public get hasValue() {
        return (this._state === 'resolved' || this._state === 'revalidating' || this._state === 'refreshing') && this._error == null;
    }

    public get error(): unknown { return this._error; }

    /** The kind of load currently in flight, or null when idle/settled. */
    public get pendingState(): PendingLoadState | null {
        const state = this._state;
        return state !== null && state !== 'resolved' && state !== 'failed' ? state : null;
    }

    /** @inheritdoc */
    public hasResolvedValue(): this is LazyPromise<T, TInitial> & IResolvedLazyPromise<T, TInitial> {
        return (this._state === 'resolved' || this._state === 'revalidating' || this._state === 'refreshing') && this._error == null;
    }

    public get promise(): Promise<T | TInitial> {
        this.ensureInstanceLoading();
        return this._promise!;
    }

    get value(): T | TInitial {
        this.ensureInstanceLoading();
        return this._instance;
    }

    /** Returns current value without triggering loading. */
    public get currentValue(): T | TInitial {
        return this._instance;
    }

    /** Configures automatic cache expiration using an expire tracker. */
    public withExpire(tracker: IExpireTracker | undefined) {
        this._expireTracker = tracker;
        return this;
    }

    public withAsyncStateChange(enabled: boolean) {
        this._isAsyncStateChange = enabled;
        return this;
    }

    /**
     * Configures the per-pending-state `isLoading` override; missing keys fall back to {@link DEFAULT_LOADING_STATE}.
     * The strategy is stored as-is (not copied), so getter-based fields are re-evaluated on each read.
     * Subsequent calls replace the previous strategy, not merge with it.
     */
    public withLoadingState(strategy: LoadingStateStrategy) {
        this._loadingStrategy = strategy;
        return this;
    }

    /** Returns a read-only fork reporting `isLoading` per `strategy`; shares lifecycle with this instance. */
    public view(strategy: LoadingStateStrategy): ILazyPromise<T, TInitial> {
        return viewLoadingState<T, TInitial>(this, strategy);
    }

    /**
     * Extends this instance with additional functionality via in-place mutation.
     *
     * **Capabilities:**
     * - `overrideFactory`: Wrap the factory (logging, retry, caching, etc.)
     * - `extendShape`: Add custom properties/methods
     * - `dispose`: Cleanup resources when disposed
     *
     * **Type Safety:**
     * - Use `ILazyPromiseExtension<any>` for universal extensions
     * - Use `ILazyPromiseExtension<ConcreteType>` for type-specific extensions
     *
     * **Note:** Extensions mutate the instance and can be chained.
     *
     * @param extension - Extension configuration
     * @returns The same instance with applied extensions
     *
     * @example
     * ```typescript
     * const logged = lazy.extend({
     *   overrideFactory: (factory) => async (refreshing) => {
     *     console.log('Loading...');
     *     return await factory(refreshing);
     *   }
     * });
     * ```
     */
    public extend<TExtShape extends object = object>(
        // Partial allows extensions with extra properties beyond the interface
        // 'any' type parameter doesn't affect return type since we return 'this'
        extension: Partial<ILazyPromiseExtension<any, TExtShape>>,
    ): object extends TExtShape ? this : this & TExtShape {

        let extended = this as this & TExtShape;

        // Apply shape extension if provided
        if (extension.extendShape) {
            extended = extension.extendShape(this) as this & TExtShape;
        }

        // Override the factory if provided
        if (extension.overrideFactory) {
            this._factory = extension.overrideFactory(this._factory, extended);
        }

        if (extension.dispose) {
            const previousDisposer = this._ownDisposer;
            const nextDisposer = extension.dispose;

            this._ownDisposer = () => {
                nextDisposer(extended);
                previousDisposer?.();
            };
        }

        return extended;
    }

    /**
     * Manually sets the value and marks loading as complete.
     * Clears any errors and restarts the expiration tracker if configured.
     *
     * @param res - The value to set
     * @returns The value that was set
     */
    public setInstance(res: T) {
        this.updateState('resolved');
        this.clearError(); // clear error on successful set

        // refresh promise so it won't keep old callbacks
        // + make sure it's resolved with the freshest value
        // also do this before setting the instance... just in case :)
        this._promise = Promise.resolve(res);
        this._activeFactoryPromise = null;

        this._instance = res;

        this._expireTracker?.restart();

        return res;
    }

    /**
     * Re-executes the factory to get fresh data.
     *
     * **Concurrency handling:**
     * - Supersedes any in-progress load or refresh
     * - Multiple concurrent refreshes: latest wins
     * - All awaiting promises receive the final refreshed value
     *
     * @returns Promise resolving to the refreshed value
     */
    public async refresh(): Promise<T | TInitial> {
        const nextState = this.refreshTargetState();
        this.startLoading(true);

        if (this._isAsyncStateChange) {
            Promise.resolve().then(() => {
                this.updateState(nextState);
            });
        } else {
            this.updateState(nextState);
        }

        return this._promise!;
    }

    /** A load already in flight keeps its classification; otherwise it's derived from the last settled state. */
    private refreshTargetState(): PendingLoadState {
        const state = this._state;
        switch (state) {
            case null:
                return 'refreshing:cold';
            case 'resolved':
            case 'revalidating':
                return 'refreshing';
            case 'failed':
                return 'refreshing:failed';
            default:
                return state;
        }
    }

    public reset() {
        this.updateState(null);
        this.clearError();

        const wasDisposed = tryDispose(this._instance);

        this._instance = this._initial;

        const p = this._promise;
        this._promise = undefined;
        this._activeFactoryPromise = null; // Clear active promise reference

        // check if loading is still in progress
        // need to dispose abandoned value
        if (p && !wasDisposed) {
            p.then(value => {
                tryDispose(value);
            });
        }
    }

    public dispose() {
        this._ownDisposer?.();
        this.reset();
    }

    private ensureInstanceLoading() {
        let nextState: PendingLoadState | undefined;

        if (this._state === null) {
            nextState = 'loading';
        } else if (
            (this._state === 'resolved' || this._state === 'failed')
            && this._instance !== undefined
            && this._expireTracker?.isExpired
        ) {
            // nothing resolved to revalidate after a failure
            nextState = this._state === 'resolved' ? 'revalidating' : 'loading';
        }

        if (nextState !== undefined) {
            this.startLoading(false);

            if (this._isAsyncStateChange) {
                Promise.resolve().then(() => {
                    this.updateState(nextState);
                });
            } else {
                this.updateState(nextState);
            }
        }
    }

    private startLoading(refreshing: boolean) {
        if (!refreshing && this._activeFactoryPromise) {
            // Case when refreshing already is happening - we have an active promise
            return;
        }

        let factoryResult: Promise<T> | T;
        try {
            factoryResult = this._factory(refreshing);
        } catch (err) {
            // Re-throwing the original error from the synchronous factory call
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            factoryResult = Promise.reject(err);
        }
        const factoryPromise: Promise<T | TInitial> = Promise.resolve(factoryResult)
            .then(res => {
                if (!this._activeFactoryPromise) {
                    // this promise was abandoned: was superseded or reset called
                    return this._instance ?? this._initial;
                }

                if (this._activeFactoryPromise === factoryPromise) {
                    // case: during the promise `setInstance` was called manually
                    if (!refreshing && this._state === 'resolved') {
                        return this._instance;
                    }
                    this.setInstance(res);
                    return res;
                }

                // Stale promise - return the latest active promise instead
                // This ensures anyone awaiting this old promise gets the fresh value
                return this._activeFactoryPromise;
            })
            .catch(err => {
                if (!this._activeFactoryPromise) {
                    // Abandoned (reset/dispose was called) — don't corrupt state
                    return this._instance ?? this._initial;
                }
                if (this._activeFactoryPromise === factoryPromise) {
                    return this.onRejected(err);
                }
                // Stale promise — delegate to the latest active promise instead of re-throwing
                return this._activeFactoryPromise;
            });

        const hadActive = !!this._activeFactoryPromise;

        // This is now the active promise - any previous one is superseded
        this._activeFactoryPromise = factoryPromise;

        // don't overwrite an existing promise (e.g., from refresh)
        // it should pick up the new active promise automatically
        if (!this._promise || !hadActive) {
            this._promise = factoryPromise;
        }
    }

    protected onRejected(e: unknown): T | TInitial {
        const keptStaleValue = this._state === 'revalidating' || this._state === 'refreshing';
        this.updateState(keptStaleValue ? 'resolved' : 'failed');
        // Keep the current instance on error (don't reset to initial)
        // This allows retaining the last successful value
        const currentInstance = this._instance !== undefined ? this._instance : this._initial;
        this._promise = Promise.resolve(currentInstance);
        this._activeFactoryPromise = null;
        this.setError(e);
        return currentInstance;
    }

    protected updateState(state: LazyPromiseState) {
        this._state = state;
    }

    protected setError(err: unknown) {
        this._error = err;
    }

    protected clearError() {
        this._error = null;
    }
}
