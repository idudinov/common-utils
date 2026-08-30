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
