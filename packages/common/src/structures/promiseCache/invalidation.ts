import type { InvalidationConfig } from './types.js';

/**
 * Evaluates an {@link InvalidationConfig} for a single key: time-based expiration first,
 * then the `invalidationCheck` callback (only run against a currently cached value).
 *
 * @param getValue Lazily reads the current cached value; only called when a callback check is configured.
 * @param timestamp The key's cached-at timestamp, or `undefined` if never stored.
 */
export function isInvalidated<T>(
    config: InvalidationConfig<T> | null,
    key: string,
    getValue: () => { has: boolean; value?: T },
    timestamp: number | undefined,
): boolean {
    if (!config) {
        return false;
    }

    const expirationMs = config.expirationMs;
    if (expirationMs != null && expirationMs > 0 && timestamp != null) {
        if (Date.now() - timestamp > expirationMs) {
            return true;
        }
    }

    if (config.invalidationCheck) {
        const { has, value } = getValue();
        if (has && config.invalidationCheck(key, value, timestamp ?? 0)) {
            return true;
        }
    }

    return false;
}


/**
 * Resolve times by key, for a cache to decide expiry against. Forced staleness is a flag on an
 * entry rather than a second map, encoded in the stored sign; reads decode, so the encoding is
 * not observable from outside.
 */
export class ResolveTimestamps {
    protected readonly _map = new Map<string, number>();

    /** The key's resolve time, or `undefined` if it was never stamped. Forced staleness does not change it. */
    get(key: string): number | undefined {
        const stored = this._map.get(key);
        return stored == null ? undefined : Math.abs(stored);
    }

    has(key: string): boolean {
        return this._map.has(key);
    }

    /** Begins a fresh lifetime for the key at the current time, dropping any forced staleness. */
    stamp(key: string) {
        this._map.set(key, Date.now());
    }

    /** Marks the key stale whatever its resolve time, keeping that time for {@link consumeForcedExpiry}. */
    forceExpire(key: string) {
        this._map.set(key, -Math.abs(this._map.get(key) ?? Date.now()));
    }

    isForcedExpired(key: string): boolean {
        const stored = this._map.get(key);
        // `Object.is` covers `-0`, which a `< 0` test misses — a key stamped at `Date.now() === 0` encodes to `-0`
        return stored != null && (stored < 0 || Object.is(stored, -0));
    }

    /** Drops forced staleness, restoring the resolve time it was set from. No-op for an unstamped key. */
    consumeForcedExpiry(key: string) {
        const stored = this._map.get(key);
        if (stored != null) {
            this._map.set(key, Math.abs(stored));
        }
    }

    delete(key: string) {
        this._map.delete(key);
    }

    clear() {
        this._map.clear();
    }
}
