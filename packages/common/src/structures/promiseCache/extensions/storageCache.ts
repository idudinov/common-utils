import type { IStorageSync } from '../../../storage/types.js';
import type {
    FetchContext,
    FetchRequest,
    FetchRequestHandler,
    IControllablePromiseCache,
    PromiseCacheEvent,
    PromiseCacheRemovedEvent,
    PromiseCacheStoredEvent,
} from '../types.js';
import type { IPromiseCacheExtension } from './types.js';

/**
 * How stale a cached value has to be before {@link StorageCacheExtension.shouldReadStorage} reads `storage` for it.
 *
 * Values:
 * - `'absent'` — only an absent value does
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
 * - a fetch attempt reads `storage` before calling the fetcher, when {@link shouldReadStorage} allows it; `readOn` sets the default policy
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
        target: IControllablePromiseCache<T, TKey, T | undefined>,
    ): FetchRequestHandler<T, TKey> {
        return (request: FetchRequest<T, TKey>) => {
            const { key, context } = request;

            if (this.shouldReadStorage(request, target)) {
                const cached = this.readFromStorage(key);
                if (cached != null) {
                    this.markServedFromStorage(context);
                    return cached;
                }
            }

            this.clearServedFromStorage(context);
            return request.next();
        };
    }

    onStored(event: PromiseCacheStoredEvent<T, TKey>): void {
        if (!this.shouldWrite(event)) {
            return;
        }
        this.writeToStorage(event.key, event.value);
    }

    onRemoved(event: PromiseCacheRemovedEvent<T, TKey>): void {
        if (!this.shouldRemove(event)) {
            return;
        }
        this.removeFromStorage(event.key);
    }

    onCleared(_event: PromiseCacheEvent<T, TKey>): void {
        this.clearStorage();
    }

    // --- Protected overridables ---

    /**
     * Whether a fetch attempt reads `storage` before calling the fetcher.
     *
     * Decides:
     * - `false` whenever `request.refreshing` is `true`
     * - for a key holding no value, `true` unless an error is stored for it
     * - for a key stale-marked by `expire()`, read `storage` only if {@link readOnForced} allows it
     * - otherwise, per the configured {@link StorageCacheReadOn}
     */
    protected shouldReadStorage(
        request: FetchRequest<T, TKey>,
        _target: IControllablePromiseCache<T, TKey, T | undefined>,
    ): boolean {
        const { state } = request;

        if (request.refreshing) {
            return false;
        }

        if (!state.hasValue) {
            return state.error == null;
        }

        if (state.invalidatedBy === 'forced') {
            return this.readOnForced;
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

    /** Whether a key stale-marked by `expire()` may be served from `storage`. */
    protected get readOnForced(): boolean {
        return false;
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

    /** Whether a removed key should also be removed from `storage`. */
    protected shouldRemove(_event: PromiseCacheRemovedEvent<T, TKey>): boolean {
        return true;
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

    /** Drops a fetch attempt's {@link markServedFromStorage} mark. */
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
