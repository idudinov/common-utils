import { tryDispose, type IDisposable } from '../functions/disposer.js';
import type { IResettableModel } from '../models/types.js';
import { ExpireTracker, type IExpireTracker } from '../structures/expire.js';
import type { ILazy } from './types.js';

/**
 * Synchronous lazy-loading container that initializes a value on first access.
 * The value is cached until reset or expired. Supports custom disposal and cache expiration.
 */
export class Lazy<T> implements ILazy<T>, IDisposable, IResettableModel {

    protected _instance: T | undefined = undefined;
    private _expireTracker: IExpireTracker = ExpireTracker.neverExpiring();
    private _disposer?: (prev: T) => void;
    private _error: unknown = null;

    constructor(protected readonly _factory: (() => T)) { }

    public get hasValue() { return this._instance !== undefined; }

    public get value() {
        this.ensureInstance();
        return this._instance as T;
    }

    public get currentValue() { return this._instance; }
    public get error(): unknown { return this._error; }

    /** The expiration tracker; once it expires, the next access resets and re-creates the value. Defaults to a never-expiring owned tracker. */
    public get expireTracker(): IExpireTracker {
        return this._expireTracker;
    }

    /** Override me: additional way to make sure instance is valid */
    protected get isValid() {
        if (!this.hasValue) {
            return false;
        }

        if (this._expireTracker.isExpired) {
            this.reset();
            return false;
        }

        return true;
    }

    /** Provides custom cleanup logic when the instance is reset or disposed. */
    public withDisposer(disposer: (prev: T) => void) {
        this._disposer = disposer;
        return this;
    }

    /** Configures automatic cache expiration: a lifetime in ms constructs and owns an {@link ExpireTracker}. */
    public withExpire(lifetimeMs: number): this;
    /** Configures automatic cache expiration using an expire tracker; `undefined` resets to a fresh never-expiring tracker. */
    public withExpire(tracker: IExpireTracker | undefined): this;
    public withExpire(arg: number | IExpireTracker | undefined) {
        this._expireTracker = typeof arg === 'number'
            ? new ExpireTracker(arg)
            : arg ?? ExpireTracker.neverExpiring();
        if (this._instance !== undefined) {
            this._expireTracker.restart();
        }
        return this;
    }

    /** Eagerly loads the value without accessing it. Useful for preloading. */
    public prewarm() {
        this.ensureInstance();
        return this;
    }

    /** Manually sets the cached value. */
    public setInstance(instance: T | undefined) {
        this._instance = instance;

        if (this._instance !== undefined) {
            this._expireTracker.restart();
        }
    }

    public reset() {
        if (this.hasValue && this._instance) {
            if (this._disposer) {
                this._disposer(this._instance);
            } else {
                tryDispose(this._instance);
            }
        }
        this.setInstance(undefined);
        this._error = null;
    }

    public dispose() { this.reset(); }

    private ensureInstance() {
        if (this.isValid) {
            return;
        }

        // additional reset to make sure previous instance has been disposed
        this.reset();
        try {
            const res = this._factory();
            this.setInstance(res);
        } catch (e: unknown) {
            this._error = e;
        }
    }
}
