import { assert } from '../functions/assert.js';
import { combineDisposers, tryDispose, type IDisposable } from '../functions/disposer.js';
import type { IResettableModel, IValueModel, ValueStorageProvider } from '../models/types.js';
import { applyExtensionShape } from '../structures/extension.js';
import { ExpireTracker, type IExpireTracker } from '../structures/expire.js';
import type { ILazyPromiseExtension } from './extensions/types.js';
import { deriveIsLoading, passivePendingKind, refreshPendingKind } from './loadingState.js';
import type {
    IControllableLazyPromise,
    IResolvedLazyPromise,
    LazyFactory,
    LazyPromiseOptions,
    LoadingStateStrategy,
    PendingLoadState,
} from './types.js';

/** Default storage provider: plain, non-observable boxes. */
const defaultStorageProvider: ValueStorageProvider = {
    createValue: <V>(initial: V) => ({ value: initial }),
};

/**
 * Asynchronous lazy-loading container that initializes via a promise-based factory.
 * Handles concurrent operations with "latest wins" semantics: multiple refreshes are automatically
 * coordinated so all awaiting promises receive the final value. Supports extensions for custom behavior.
 */
export class LazyPromise<T, TInitial extends T | undefined = undefined> implements IControllableLazyPromise<T, TInitial>, IDisposable, IResettableModel {

    private _factory: LazyFactory<T>;
    private readonly _initial: TInitial;

    private readonly _instance: IValueModel<T | TInitial>;

    /**
     * `_pending` records the in-flight load kind, `_settled` records how the last finished load ended.
     * `'refreshing'`/`'revalidating'` in `_pending` require `_settled.value === 'resolved'`.
     * Both fields are written only by `beginPending`, `settle`, and `reset`.
     */
    private readonly _pending: IValueModel<PendingLoadState | null>;
    private readonly _settled: IValueModel<'resolved' | 'failed' | null>;

    private readonly _loadingStrategy: IValueModel<LoadingStateStrategy | undefined>;

    private _isAsyncStateChange = false;

    private _promise: Promise<T | TInitial> | undefined;
    private _expireTracker: IExpireTracker = ExpireTracker.neverExpiring();

    // Track the active factory promise to determine "latest wins"
    private _activeFactoryPromise: Promise<T | TInitial> | null = null;
    private readonly _error: IValueModel<unknown>;

    private readonly _prepareValue: (value: T) => T;

    /** Runs a group of mutations as one change batch and returns `fn`'s result; identity if none was supplied. */
    private readonly _transaction: <R>(fn: () => R) => R;

    private _ownDisposer?: () => void;

    constructor(
        factory: LazyFactory<T>,
        initial?: TInitial,
        options?: LazyPromiseOptions<T>,
    ) {
        this._factory = factory;
        this._initial = initial as TInitial;

        const storage = options?.storage ?? defaultStorageProvider;
        this._prepareValue = options?.prepareValue ?? (value => value);
        this._transaction = storage.transaction?.bind(storage) ?? (fn => fn());

        this._instance = storage.createValue<T | TInitial>(initial as T | TInitial);
        this._pending = storage.createValue<PendingLoadState | null>(null);
        this._settled = storage.createValue<'resolved' | 'failed' | null>(null);
        this._error = storage.createValue<unknown>(null);
        this._loadingStrategy = storage.createValue<LoadingStateStrategy | undefined>(undefined);
    }

    /** Current loading state: true = loading, false = loaded, null = not started. Pending states report per {@link withLoadingState}. */
    public get isLoading(): boolean | null {
        const pending = this._pending.value;
        if (pending !== null) {
            return deriveIsLoading(pending, this._loadingStrategy.value);
        }
        return this._settled.value !== null ? false : null;
    }

    /**
     * Returns true if a value of type `T` has been successfully loaded (no error).
     * Stays `true` while a refresh/revalidation is in flight; use {@link isLoading} to hide stale values.
     * Exception: a failed-then-retried load clears this to `false` for the retry's duration too, since the
     * stored error takes precedence over the kept stale value.
     */
    public get hasValue() {
        return this._settled.value === 'resolved' && this._error.value == null;
    }

    public get error(): unknown { return this._error.value; }

    /** The kind of load currently in flight, or null when idle/settled. */
    public get pendingState(): PendingLoadState | null {
        return this._pending.value;
    }

    public hasResolvedValue(): this is LazyPromise<T, TInitial> & IResolvedLazyPromise<T, TInitial> {
        return this.hasValue;
    }

    public get promise(): Promise<T | TInitial> {
        this.ensureInstanceLoading();
        return this._promise!;
    }

    get value(): T | TInitial {
        this.ensureInstanceLoading();
        return this._instance.value;
    }

    /** Returns current value without triggering loading. */
    public get currentValue(): T | TInitial {
        return this._instance.value;
    }

    /**
     * The expiration tracker driving revalidation; defaults to a never-expiring owned tracker.
     * Expiring while a load is already in flight is absorbed by that load's successful settle —
     * a resolved outcome restarts the tracker regardless of what happened to it in the meantime.
     */
    public get expireTracker(): IExpireTracker {
        return this._expireTracker;
    }

    /** Configures automatic cache expiration: a lifetime in ms constructs and owns an {@link ExpireTracker}. */
    public withExpire(lifetimeMs: number): this;
    /** Configures automatic cache expiration using an expire tracker; `undefined` resets to a fresh never-expiring tracker. */
    public withExpire(tracker: IExpireTracker | undefined): this;
    public withExpire(arg: number | IExpireTracker | undefined) {
        this._expireTracker = typeof arg === 'number'
            ? new ExpireTracker(arg)
            : arg ?? ExpireTracker.neverExpiring();
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
        this._loadingStrategy.value = strategy;
        return this;
    }

    /**
     * Extends this instance with additional functionality via in-place mutation, per the given
     * {@link ILazyPromiseExtension}. Extensions chain: calling `extend()` again wraps on top of
     * the previous one, in the order they were applied.
     *
     * @param extension Extension configuration.
     * @returns The same instance, typed with the extension's shape additions if any.
     */
    public extend<TExtShape extends object = object>(
        // Partial allows extensions with extra properties beyond the interface
        // 'any' type parameter doesn't affect return type since we return 'this'
        extension: Partial<ILazyPromiseExtension<any, TExtShape>>,
    ): object extends TExtShape ? this : this & TExtShape {

        const extended = applyExtensionShape<this, TExtShape>(
            this,
            extension.extendShape as ((previous: this) => this & TExtShape) | undefined,
        );

        // Override the factory if provided
        if (extension.overrideFactory) {
            this._factory = extension.overrideFactory(this._factory, extended);
        }

        if (extension.dispose) {
            const nextDisposer = extension.dispose;
            this._ownDisposer = combineDisposers(() => nextDisposer(extended), this._ownDisposer);
        }

        return extended;
    }

    /**
     * Manually sets the value and marks loading as complete.
     * Clears any errors and restarts the expiration tracker.
     *
     * @param res - The value to set
     * @returns The value that was set
     */
    public setInstance(res: T) {
        const prepared = this._prepareValue(res);

        this._transaction(() => {
            this.settle('resolved');
            this.clearError(); // clear error on successful set
            this._instance.value = prepared;

            // refresh promise so it won't keep old callbacks, resolved with the freshest value
            this._promise = Promise.resolve(prepared);
            this._activeFactoryPromise = null;

            this._expireTracker.restart();
        });

        return prepared;
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
        const factoryPromise = this.startLoading(true);

        this.applyPending(nextState);

        return factoryPromise;
    }

    /**
     * Applies a pending-state transition immediately, or deferred (per `withAsyncStateChange`) unless a newer
     * factory promise has replaced the one active when this write was scheduled.
     */
    private applyPending(next: PendingLoadState) {
        if (!this._isAsyncStateChange) {
            this.beginPending(next);
            return;
        }
        const active = this._activeFactoryPromise;
        Promise.resolve().then(() => {
            if (this._activeFactoryPromise === active) {
                this.beginPending(next);
            }
        });
    }

    /** A load already in flight keeps its classification; otherwise it's derived from the last settled state. */
    private refreshTargetState(): PendingLoadState {
        // a kept stale value counts even when the last refresh errored, so `hasValue` (error-sensitive) doesn't fit here
        return refreshPendingKind(this._pending.value, this._settled.value === 'resolved');
    }

    public reset() {
        const oldInstance = this._instance.value;
        const p = this._promise;

        // _promise/_activeFactoryPromise are cleared in the same transaction as the box writes, so a
        // reactive read triggered mid-transaction (e.g. a dependent's auto-refresh) never observes a
        // half-reset instance still holding the abandoned active promise
        this._transaction(() => {
            this._pending.value = null;
            this._settled.value = null;
            this.clearError();
            this._instance.value = this._initial;
            this._promise = undefined;
            this._activeFactoryPromise = null;
        });

        const wasDisposed = tryDispose(oldInstance);

        // check if loading is still in progress
        // need to dispose abandoned value
        if (p && !wasDisposed) {
            p.then(value => {
                // this promise's abandoned branch can resolve to whatever is live by the time it settles
                // (e.g. a value set by a load that started after this reset) — never dispose that one
                if (value !== this._instance.value) {
                    tryDispose(value);
                }
            });
        }
    }

    public dispose() {
        this._ownDisposer?.();
        this.reset();
    }

    private ensureInstanceLoading() {
        if (this._activeFactoryPromise) {
            // a load is already in flight; a passive read must not schedule a second deferred state write
            return;
        }

        let nextState: PendingLoadState | undefined;

        const settled = this._settled.value;
        if (settled === null) {
            nextState = 'loading';
        } else if (this._expireTracker.isExpired) {
            nextState = passivePendingKind(settled === 'resolved');
        }

        if (nextState !== undefined) {
            this.startLoading(false);
            this.applyPending(nextState);
        }
    }

    /** Starts (or joins) a factory call; returns the promise for this call's outcome — resolves to the instance value and never rejects. */
    private startLoading(refreshing: boolean): Promise<T | TInitial> {
        if (!refreshing && this._activeFactoryPromise) {
            // Case when refreshing already is happening - we have an active promise
            return this._activeFactoryPromise;
        }

        // Restarting at invocation paces retries: a failed attempt still starts a lifetime.
        // A successful settle restarts again, so a resolved value's lifetime is measured from settle.
        this._expireTracker.restart();

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
                    return this._instance.value ?? this._initial;
                }

                if (this._activeFactoryPromise === factoryPromise) {
                    return this.setInstance(res);
                }

                // Stale promise - return the latest active promise instead
                // This ensures anyone awaiting this old promise gets the fresh value
                return this._activeFactoryPromise;
            })
            .catch(err => {
                if (!this._activeFactoryPromise) {
                    // Abandoned (reset/dispose was called) — don't corrupt state
                    return this._instance.value ?? this._initial;
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

        return factoryPromise;
    }

    protected onRejected(e: unknown): T | TInitial {
        return this._transaction(() => {
            this.settle('failed');
            // Keep the current instance on error (don't reset to initial)
            // This allows retaining the last successful value
            const currentInstance = this._instance.value !== undefined ? this._instance.value : this._initial;
            this._promise = Promise.resolve(currentInstance);
            this._activeFactoryPromise = null;
            this.setError(e);
            return currentInstance;
        });
    }

    /** Begins a pending load; `'refreshing'`/`'revalidating'` require a prior resolved settle. */
    protected beginPending(kind: PendingLoadState) {
        assert(
            (kind !== 'refreshing' && kind !== 'revalidating') || this._settled.value === 'resolved',
            `LazyPromise: cannot begin '${kind}' without a resolved value`,
        );
        this._pending.value = kind;
    }

    /** Ends the pending load. A failed load keeps a previously resolved settle (a kept stale value survives it). */
    protected settle(outcome: 'resolved' | 'failed') {
        this._pending.value = null;
        this._settled.value = outcome === 'failed' && this._settled.value === 'resolved' ? 'resolved' : outcome;
    }

    protected setError(err: unknown) {
        this._error.value = err;
    }

    protected clearError() {
        this._error.value = null;
    }
}
