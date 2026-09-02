
export interface IExpireTracker {
    readonly isExpired: boolean;

    /** Begins a fresh lifetime from now. */
    restart(): void;

    /** Forces {@link isExpired} to report `true` until the next {@link restart}. */
    expire(): void;
}

export class ExpireTracker implements IExpireTracker {
    /** Unstarted and never-expiring are the same state: `Infinity` is never reached by `Date.now()`. */
    private _expiringAt: number = Infinity;

    constructor(public readonly lifetimeMs: number) { }

    public get isExpired() { return Date.now() >= this._expiringAt; }

    public restart() {
        this._expiringAt = Date.now() + this.lifetimeMs;
        return this;
    }

    public get remainingMs() {
        return Math.max(0, this._expiringAt - Date.now());
    }

    public expire() {
        this._expiringAt = 0;
        return this;
    }

    /** A tracker that never expires on its own — only an explicit `expire()` makes it report expired. */
    public static neverExpiring() {
        return new ExpireTracker(Infinity);
    }
}
