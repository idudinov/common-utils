import { withRetry, type RetryConfig } from '../../async/retry.js';
import type { LazyFactory } from '../types.js';
import type { ILazyPromiseExtension } from './types.js';

/** {@link ILazyPromiseExtension} that carries the {@link RetryConfig} it was created with. */
export interface IRetryExtension extends ILazyPromiseExtension {
    retryConfig?: RetryConfig;
}

/**
 * Wraps the factory of a {@link LazyPromise} (via `extend()`) with retry logic.
 *
 * @param config Retry configuration, see {@link RetryConfig}. Falls back to defaults if omitted.
 */
export function createRetryExtension(config?: RetryConfig): IRetryExtension {
    return {
        overrideFactory: <T>(previous: LazyFactory<T>) =>
            (refreshing?: boolean) => withRetry(() => previous(refreshing), config),
        retryConfig: config,
    };
}
