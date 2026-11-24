import type { ValueStorageProvider } from './types.js';

/** A {@link ValueStorageProvider} that supplies plain `{ value }` boxes, with no change tracking and no batching. */
export const plainStorageProvider: ValueStorageProvider = {
    createValue: <V>(initial: V) => ({ value: initial }),
};
