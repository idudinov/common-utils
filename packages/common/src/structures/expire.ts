
export interface IExpireTracker {
    readonly isExpired: boolean;

    /** Whether {@link expire} forced expiry, as opposed to the lifetime elapsing. */
    readonly isForceExpired: boolean;

    /** Begins a fresh lifetime from now, clearing {@link isForceExpired}. */
    restart(): void;

    /** Forces {@link isExpired} to report `true` until the next {@link restart}. */
    expire(): void;
}

export class ExpireTracker implements IExpireTracker {
    /** `Infinity` means unstarted and never-expiring, since `Date.now()` never reaches it; `0` means force-expired. */
    private _expiringAt: number = Infinity;

    constructor(public readonly lifetimeMs: number) { }

    public get isExpired() { return Date.now() >= this._expiringAt; }

    public get isForceExpired() { return this._expiringAt === 0; }

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
