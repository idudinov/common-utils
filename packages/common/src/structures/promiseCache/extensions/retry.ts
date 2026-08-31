import { withRetry, type RetryConfig } from '../../../async/retry.js';
import type { IPromiseCacheExtension } from './types.js';

/** {@link IPromiseCacheExtension} that carries the {@link RetryConfig} it was created with. */
export interface IRetryExtension<T, TKey extends string = string> extends IPromiseCacheExtension<T, TKey> {
    retryConfig?: RetryConfig;
}

/**
 * Wraps the fetcher of a {@link PromiseCache} (via `extend()`) with retry logic.
 *
 * @param config Retry configuration, see {@link RetryConfig}. Falls back to defaults if omitted.
 */
export function createRetryExtension<T, TKey extends string = string>(config?: RetryConfig): IRetryExtension<T, TKey> {
    return {
        overrideFetcher: original => (key, refreshing) => withRetry(() => original(key, refreshing), config),
        retryConfig: config,
    };
}
