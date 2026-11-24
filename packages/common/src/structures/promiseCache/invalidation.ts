import type { InvalidationConfig, InvalidationReason } from './types.js';

/**
 * Evaluates an {@link InvalidationConfig} for a single key: the `invalidationCheck` callback first
 * (only run against a currently cached value), then time-based expiration.
 *
 * @param getValue Lazily reads the current cached value; only called when a callback check is configured.
 * @param timestamp The key's cached-at timestamp, or `undefined` if never stored.
 * @returns `'check'` or `'time'` for whichever rule invalidated the key first, `null` if neither did.
 */
export function getInvalidationReason<T>(
    config: InvalidationConfig<T> | null,
    key: string,
    getValue: () => { has: boolean; value?: T },
    timestamp: number | undefined,
): Exclude<InvalidationReason, 'forced'> | null {
    if (!config) {
        return null;
    }

    if (config.invalidationCheck) {
        const { has, value } = getValue();
        if (has && config.invalidationCheck(key, value, timestamp ?? 0)) {
            return 'check';
        }
    }

    const expirationMs = config.expirationMs;
    if (expirationMs != null && expirationMs > 0 && timestamp != null) {
        if (Date.now() - timestamp > expirationMs) {
            return 'time';
        }
    }

    return null;
}

/** {@link getInvalidationReason}, collapsed to a boolean. */
export function isInvalidated<T>(
    config: InvalidationConfig<T> | null,
    key: string,
    getValue: () => { has: boolean; value?: T },
    timestamp: number | undefined,
): boolean {
    return getInvalidationReason(config, key, getValue, timestamp) != null;
}

/**
 * The time in ms after a failed attempt before a read may start another, per {@link InvalidationConfig.failureRetryMs}.
 *
 * @returns `null` when no wait applies: neither `failureRetryMs` nor a positive `expirationMs` is set.
 */
export function getFailureRetryMs<T>(config: InvalidationConfig<T> | null): number | null {
    if (config?.failureRetryMs != null) {
        return config.failureRetryMs;
    }

    const expirationMs = config?.expirationMs;
    return expirationMs != null && expirationMs > 0 ? expirationMs : null;
}

/** Per-key resolve times, forced-staleness marks and last failure times, which a cache checks expiry and retries against. */
export class ResolveTimestamps {
    protected readonly _map = new Map<string, number>();
    protected readonly _forced = new Set<string>();
    protected readonly _failed = new Map<string, number>();

    /** The key's resolve time, or `undefined` if it was never stamped. Forced staleness and failures do not change it. */
    get(key: string): number | undefined {
        return this._map.get(key);
    }

    /** The time of the key's last failed attempt, or `undefined` if none failed since a value was last stamped. */
    getFailedAt(key: string): number | undefined {
        return this._failed.get(key);
    }

    has(key: string): boolean {
        return this._map.has(key) || this._forced.has(key) || this._failed.has(key);
    }

    /**
     * Begins a fresh lifetime for the key at the current time and clears its failure time.
     * Leaves forced staleness untouched, so a mark set while a fetch is in flight survives that fetch's own stamp.
     */
    stamp(key: string) {
        this._map.set(key, Date.now());
        this._failed.delete(key);
    }

    /** Records a failed attempt at the current time, leaving the resolve time as it was. */
    stampFailure(key: string) {
        this._failed.set(key, Date.now());
    }

    /** Marks the key stale independently of its resolve time. */
    forceExpire(key: string) {
        this._forced.add(key);
    }

    isForcedExpired(key: string): boolean {
        return this._forced.has(key);
    }

    /** Drops forced staleness. Works on a key that was never stamped, including an errored one. */
    consumeForcedExpiry(key: string) {
        this._forced.delete(key);
    }

    delete(key: string) {
        this._map.delete(key);
        this._forced.delete(key);
        this._failed.delete(key);
    }

    clear() {
        this._map.clear();
        this._forced.clear();
        this._failed.clear();
    }
}
