
/**
 * Helper: creates a promise that resolves after `ms` milliseconds (works with fake timers).
 */
export function delayedValue<T>(ms: number, value: T): Promise<T> {
    return new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
}

/** Helper: creates a delayed async function that throws using fake timers */
export function delayedError(ms: number, error: Error): Promise<never> {
    return new Promise<never>((_, reject) => setTimeout(() => reject(error), ms));
}
