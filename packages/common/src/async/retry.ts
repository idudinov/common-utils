import { setTimeoutAsync } from './timeout.js';

export interface RetryConfig {
    /** Max retry attempts after the initial call. @default 3 */
    retries?: number;
    /** Delay before the first retry, in ms; doubles (times `backoffMultiplier`) each subsequent attempt. @default 1000 */
    delay?: number;
    /** Multiplier applied to `delay` after each attempt. @default 2 */
    backoffMultiplier?: number;
    /** Return true to skip retrying and rethrow the error immediately. */
    errorFilter?: (error: unknown) => boolean;
    /** Called before each retry, with the error that triggered it and the upcoming attempt's config. */
    onRetry?: (error: unknown, retriesLeft: number, delay: number) => void;
}

const DEFAULT_RETRY_CONFIG = {
    retries: 3,
    delay: 1000,
    backoffMultiplier: 2,
} as const satisfies RetryConfig;

/**
 * Runs `fn`, retrying on failure with an increasing delay between attempts.
 *
 * @param fn Function to run/retry.
 * @param config Retry configuration, see {@link RetryConfig}. Falls back to defaults for omitted fields.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    config?: RetryConfig,
): Promise<T> {
    const {
        retries,
        delay,
        backoffMultiplier,
        errorFilter,
        onRetry,
    } = { ...DEFAULT_RETRY_CONFIG, ...config };

    try {
        return await fn();
    } catch (error) {
        if (errorFilter?.(error)) {
            throw error;
        }

        if (retries <= 0) {
            throw error;
        }

        onRetry?.(error, retries, delay);

        await setTimeoutAsync(delay);

        return withRetry(
            fn,
            {
                retries: retries - 1,
                delay: delay * backoffMultiplier,
                backoffMultiplier,
                errorFilter,
                onRetry,
            },
        );
    }
}
