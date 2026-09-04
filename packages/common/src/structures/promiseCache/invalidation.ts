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
 * Resolve times by key, for a cache to decide expiry against, plus which keys are force-expired
 * independently of their resolve time.
 */
export class ResolveTimestamps {
    protected readonly _map = new Map<string, number>();
    protected readonly _forced = new Set<string>();

    /** The key's resolve time, or `undefined` if it was never stamped. Forced staleness does not change it. */
    get(key: string): number | undefined {
        return this._map.get(key);
    }

    has(key: string): boolean {
        return this._map.has(key) || this._forced.has(key);
    }

    /**
     * Begins a fresh lifetime for the key at the current time.
     * Leaves forced staleness untouched, so a mark set while a fetch is in flight survives that fetch's own stamp.
     */
    stamp(key: string) {
        this._map.set(key, Date.now());
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
    }

    clear() {
        this._map.clear();
        this._forced.clear();
    }
}
