import type { IStorageSync } from '../../../storage/types.js';
import type {
    FetchContext,
    FetchRequest,
    FetchRequestHandler,
    IControllablePromiseCache,
    PromiseCacheEvent,
    PromiseCacheKeyState,
    PromiseCacheRemovedEvent,
    PromiseCacheStoredEvent,
} from '../types.js';
import type { IPromiseCacheExtension } from './types.js';

/**
 * Which additional state, beyond an absent value, opens {@link StorageCacheExtension.shouldReadStorage}'s gate.
 *
 * Values:
 * - `'absent'` — nothing else; only an absent value opens it
 * - `'stale'` — also a value that timed out under `useInvalidation({ expirationMs })`
 * - `'invalid'` — also a value invalid for any reason, including one a configured `invalidationCheck` rejected
 */
export type StorageCacheReadOn = 'absent' | 'stale' | 'invalid';

export interface StorageCacheExtensionOptions<TKey extends string = string> {
    /** Maps a cache key to its storage key. Defaults to identity. */
    storageKey?: (key: TKey) => string;

    /** Clears the whole storage scope on `clear()`. Without it, `clear()` leaves storage untouched. */
    clearStorage?: () => void;

    /** {@link StorageCacheReadOn}, `'stale'` by default. */
    readOn?: StorageCacheReadOn;
}

/** Marks a fetch attempt whose result was served from storage. */
const FromStorage = Symbol('storageCache:fromStorage');

/**
 * Read-through/write-through persistence for a `PromiseCache`, backed by a synchronous {@link IStorageSync}.
 *
 * Reads:
 * - a fetch attempt gated open checks `storage` before the fetcher runs; `readOn` picks the default gate policy
 * - a hit is served without calling the fetcher and without writing back, so a wrapper that stamps write-side metadata (e.g. an expiry) keeps its stamp
 * - a miss falls through to the fetcher, and the result is written to `storage`
 *
 * Errors:
 * - a throw while reading `storage` is recorded as the key's fetch error
 * - a throw while writing to or removing from `storage` is logged and swallowed by the cache's own event dispatch
 */
export class StorageCacheExtension<T, TKey extends string = string> implements IPromiseCacheExtension<T, TKey> {
    protected readonly readOn: StorageCacheReadOn;

    constructor(
        protected readonly storage: IStorageSync<T | null>,
        protected readonly options?: StorageCacheExtensionOptions<TKey>,
    ) {
        this.readOn = options?.readOn ?? 'stale';
    }

    overrideFetcher(
        original: FetchRequestHandler<T, TKey>,
        target: IControllablePromiseCache<T, TKey, T | undefined>,
    ): FetchRequestHandler<T, TKey> {
        return (request: FetchRequest<TKey>) => {
            const { key, context } = request;

            if (this.shouldReadStorage(target.getState(key), request, target)) {
                const cached = this.readFromStorage(key);
                if (cached != null) {
                    this.markServedFromStorage(context);
                    return cached;
                }
            }

            this.clearServedFromStorage(context);
            return original(request);
        };
    }

    onStored(event: PromiseCacheStoredEvent<T, TKey>): void {
        if (!this.shouldWrite(event)) {
            return;
        }
        this.writeToStorage(event.key, event.value);
    }

    onRemoved(event: PromiseCacheRemovedEvent<T, TKey>): void {
        this.removeFromStorage(event.key);
    }

    onCleared(_event: PromiseCacheEvent<T, TKey>): void {
        this.clearStorage();
    }

    // --- Protected overridables ---

    /**
     * The gate deciding whether a fetch attempt checks `storage` before the fetcher runs.
     *
     * Decides:
     * - `false` whenever `request.refreshing` is `true`
     * - for a key holding no value, `true` unless an error is stored for it
     * - otherwise, per the configured {@link StorageCacheReadOn}
     */
    protected shouldReadStorage(
        state: PromiseCacheKeyState,
        request: FetchRequest<TKey>,
        _target: IControllablePromiseCache<T, TKey, T | undefined>,
    ): boolean {
        if (request.refreshing) {
            return false;
        }

        if (!state.hasValue) {
            return state.error == null;
        }

        switch (this.readOn) {
            case 'stale':
                return state.invalidatedBy === 'time';
            case 'invalid':
                return state.invalidatedBy != null;
            case 'absent':
            default:
                return false;
        }
    }

    /** Maps a cache key to its storage key, identity by default. */
    protected toStorageKey(key: TKey): string {
        return this.options?.storageKey ? this.options.storageKey(key) : key;
    }

    /** Reads `key`'s raw value from `storage`, letting a throw propagate as the key's fetch error. */
    protected readFromStorage(key: TKey): T | null {
        return this.storage.getValue(this.toStorageKey(key));
    }

    /** Writes `value` for `key` to `storage`. */
    protected writeToStorage(key: TKey, value: T): void {
        this.storage.setValue(this.toStorageKey(key), value);
    }

    /** Removes `key` from `storage`. */
    protected removeFromStorage(key: TKey): void {
        this.storage.removeValue(this.toStorageKey(key));
    }

    /** Whether a successful store should be written to `storage` — `false` for a value just served from it. */
    protected shouldWrite(event: PromiseCacheStoredEvent<T, TKey>): boolean {
        return !this.wasServedFromStorage(event.context);
    }

    /**
     * Clears the whole storage scope.
     * A no-op unless `clearStorage` was supplied to the constructor.
     */
    protected clearStorage(): void {
        this.options?.clearStorage?.();
    }

    /** Marks a fetch attempt's context as served from `storage`, so its store is not written back. */
    protected markServedFromStorage(context: FetchContext): void {
        context[FromStorage] = true;
    }

    /**
     * Drops a fetch attempt's {@link markServedFromStorage} mark.
     * A wrapper that re-issues an attempt on the same context relies on this to keep a later network result writable.
     */
    protected clearServedFromStorage(context: FetchContext): void {
        delete context[FromStorage];
    }

    /** Whether a fetch attempt's context was marked by {@link markServedFromStorage}. */
    protected wasServedFromStorage(context: FetchContext | undefined): boolean {
        return context?.[FromStorage] === true;
    }
}

/** Equivalent to `new StorageCacheExtension(storage, options)`. */
export function createStorageCacheExtension<T, TKey extends string = string>(
    storage: IStorageSync<T | null>,
    options?: StorageCacheExtensionOptions<TKey>,
): StorageCacheExtension<T, TKey> {
    return new StorageCacheExtension<T, TKey>(storage, options);
}
