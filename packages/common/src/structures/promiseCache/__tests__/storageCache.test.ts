
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IStorageSync } from '../../../storage/types.js';
import { StorageCacheExtension } from '../extensions/storageCache.js';
import { createStorageCacheExtension, PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

/** In-memory sync storage fake, keyed like {@link IStorageSync}. */
class FakeStorage<T> implements IStorageSync<T | null> {
    readonly map = new Map<string, T | null>();

    getValue(key: string): T | null {
        return this.map.get(key) ?? null;
    }

    setValue(key: string, value: T | null): void {
        this.map.set(key, value);
    }

    hasValue(key: string): boolean {
        return this.map.has(key);
    }

    removeValue(key: string): boolean {
        return this.map.delete(key);
    }
}

/** In-memory sync storage fake that stamps each write and expires it after `ttlMs` — a stand-in for a real storage backend's own TTL. */
class TtlFakeStorage<T> implements IStorageSync<T | null> {
    private readonly entries = new Map<string, { value: T; storedAt: number }>();

    constructor(private readonly ttlMs: number) { }

    getValue(key: string): T | null {
        const entry = this.entries.get(key);
        if (!entry || Date.now() - entry.storedAt > this.ttlMs) {
            return null;
        }
        return entry.value;
    }

    setValue(key: string, value: T | null): void {
        if (value == null) {
            this.entries.delete(key);
            return;
        }
        this.entries.set(key, { value, storedAt: Date.now() });
    }

    hasValue(key: string): boolean {
        return this.getValue(key) != null;
    }

    removeValue(key: string): boolean {
        return this.entries.delete(key);
    }
}

describe('PromiseCache storage cache extension', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('cold cache + storage hit: fetcher not called, value served, no write-back', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');
        const setValueSpy = vi.spyOn(storage, 'setValue');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();
        expect(cache.getCurrent('a', false)).toBe('from-storage');
        // no write-back: a storage wrapper stamping metadata on write (e.g. expiry) keeps its original stamp
        expect(setValueSpy).not.toHaveBeenCalled();
    });

    test('set() during an in-flight storage-served get() still writes the manual value once', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');
        const setValueSpy = vi.spyOn(storage, 'setValue');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        const getPromise = cache.get('a'); // storage-served, resolves on a later microtask
        cache.set('a', 'manual');
        await getPromise;

        expect(cache.getCurrent('a', false)).toBe('manual');
        expect(setValueSpy).toHaveBeenCalledTimes(1);
        expect(setValueSpy).toHaveBeenCalledWith('a', 'manual');
    });

    test('a throwing storage.getValue is recorded as the fetch error, same as a failing fetcher', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');
        vi.spyOn(storage, 'getValue').mockImplementation(() => {
            throw new Error('storage broken');
        });

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        await expect(cache.get('a')).resolves.toBeUndefined();
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('cold cache + storage miss: fetcher called, result written to storage', async () => {
        const storage = new FakeStorage<string>();

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(storage.map.get('a')).toBe('fetched-a');
    });

    test('refresh() calls the fetcher even with a storage hit available, and writes the result', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => `fresh-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        await expect(cache.refresh('a')).resolves.toBe('fresh-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(storage.map.get('a')).toBe('fresh-a');
    });

    test('set() writes to storage, delete() removes from storage', async () => {
        const storage = new FakeStorage<string>();
        const cache = new PromiseCache<string>(async key => key).extend(createStorageCacheExtension(storage));

        cache.set('a', 'manual');
        expect(storage.map.get('a')).toBe('manual');

        cache.delete('a');
        expect(storage.map.has('a')).toBe(false);
    });

    test('clear() calls clearStorage when provided, leaves storage untouched otherwise', async () => {
        const storage = new FakeStorage<string>();
        const clearStorage = vi.fn();

        const cacheWithClear = new PromiseCache<string>(async key => key)
            .extend(createStorageCacheExtension(storage, { clearStorage }));

        cacheWithClear.set('a', 'val-a');
        cacheWithClear.clear();
        expect(clearStorage).toHaveBeenCalledTimes(1);

        const cacheWithoutClear = new PromiseCache<string>(async key => key)
            .extend(createStorageCacheExtension(storage));

        cacheWithoutClear.set('b', 'val-b');
        cacheWithoutClear.clear();
        expect(storage.map.get('b')).toBe('val-b');
    });

    test('storageKey mapping applies to both reads and writes', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('prefix:a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend(createStorageCacheExtension(storage, { storageKey: key => `prefix:${key}` }));

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();

        await expect(cache.get('b')).resolves.toBe('fetched-b');
        expect(storage.map.get('prefix:b')).toBe('fetched-b');
    });

    test('expire(key) forces the next get() to call the fetcher instead of reading storage', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();

        cache.expire('a');

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(storage.map.get('a')).toBe('fetched-a');
    });

    test("readOn: 'absent' — useInvalidation({ expirationMs }) refetches instead of reading storage once expired", async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend(createStorageCacheExtension(storage, { readOn: 'absent' }))
            .useInvalidation({ expirationMs: 100 });

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(101);

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    describe('readOn (default: \'stale\')', () => {
        test('an in-memory lapse within storage\'s own TTL still serves from storage, not the fetcher', async () => {
            const storage = new TtlFakeStorage<string>(10 * 60_000); // 10 min storage TTL
            storage.setValue('a', 'from-storage');

            const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
            const cache = new PromiseCache<string>(fetcher)
                .extend(new StorageCacheExtension(storage))
                .useInvalidation({ expirationMs: 60_000 }); // 1 min in-memory window

            await expect(cache.get('a')).resolves.toBe('from-storage');
            expect(fetcher).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(61_000); // in-memory value lapses, storage still good

            await expect(cache.get('a')).resolves.toBe('from-storage');
            expect(fetcher).not.toHaveBeenCalled();
        });

        test('a lapse past storage\'s own TTL calls the fetcher and re-stamps storage', async () => {
            const storage = new TtlFakeStorage<string>(5_000);
            storage.setValue('a', 'from-storage');

            const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
            const cache = new PromiseCache<string>(fetcher)
                .extend(new StorageCacheExtension(storage))
                .useInvalidation({ expirationMs: 1_000 });

            await expect(cache.get('a')).resolves.toBe('from-storage');
            expect(fetcher).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(6_000); // both the in-memory window and storage lapse

            await expect(cache.get('a')).resolves.toBe('fetched-a');
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(storage.getValue('a')).toBe('fetched-a');
        });

        test('a value-based invalidationCheck calls the fetcher rather than reading storage again', async () => {
            const storage = new FakeStorage<string>();
            storage.map.set('a', 'stale-schema-value');

            const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
            let rejectValue = false;
            const cache = new PromiseCache<string>(fetcher)
                .extend(createStorageCacheExtension(storage))
                .useInvalidation({ invalidationCheck: () => rejectValue });

            await expect(cache.get('a')).resolves.toBe('stale-schema-value');
            expect(fetcher).not.toHaveBeenCalled();

            rejectValue = true;
            await expect(cache.get('a')).resolves.toBe('fetched-a');
            expect(fetcher).toHaveBeenCalledTimes(1);
        });

        test('a rejected value that also timed out calls the fetcher rather than reading storage', async () => {
            const storage = new FakeStorage<string>();
            storage.map.set('a', 'stale-schema-value');

            const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
            let rejectValue = false;
            const cache = new PromiseCache<string>(fetcher)
                .extend(createStorageCacheExtension(storage))
                .useInvalidation({ expirationMs: 1_000, invalidationCheck: () => rejectValue });

            await expect(cache.get('a')).resolves.toBe('stale-schema-value');
            expect(fetcher).not.toHaveBeenCalled();

            rejectValue = true;
            await vi.advanceTimersByTimeAsync(1_100); // both rules now match the cached value

            await expect(cache.get('a')).resolves.toBe('fetched-a');
            expect(fetcher).toHaveBeenCalledTimes(1);
        });

        test('expire() with a lapsed expirationMs calls the fetcher, not storage', async () => {
            const storage = new FakeStorage<string>();

            const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
            const cache = new PromiseCache<string>(fetcher)
                .extend(createStorageCacheExtension(storage))
                .useInvalidation({ expirationMs: 50 });

            await expect(cache.get('a')).resolves.toBe('fetched-a');
            expect(fetcher).toHaveBeenCalledTimes(1);

            cache.expire('a');
            storage.map.set('a', 'from-storage'); // shows up out-of-band — must be bypassed, expire() means network

            await vi.advanceTimersByTimeAsync(60); // expirationMs also lapses before the next read

            await expect(cache.get('a')).resolves.toBe('fetched-a');
            expect(fetcher).toHaveBeenCalledTimes(2);
        });
    });

    test("readOn: 'invalid' — a value-based invalidationCheck reads storage again instead of calling the fetcher", async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'stale-schema-value');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        let rejectValue = false;
        const cache = new PromiseCache<string>(fetcher)
            .extend(createStorageCacheExtension(storage, { readOn: 'invalid' }))
            .useInvalidation({ invalidationCheck: () => rejectValue });

        await expect(cache.get('a')).resolves.toBe('stale-schema-value');
        expect(fetcher).not.toHaveBeenCalled();

        rejectValue = true;
        await expect(cache.get('a')).resolves.toBe('stale-schema-value');
        expect(fetcher).not.toHaveBeenCalled();
    });

    test.each(['absent', 'stale', 'invalid'] as const)(
        "readOn: '%s' — with no invalidation configured, a populated key never reads storage again",
        async (readOn) => {
            const storage = new FakeStorage<string>();
            storage.map.set('a', 'from-storage');

            const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
            const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage, { readOn }));

            await expect(cache.get('a')).resolves.toBe('from-storage');
            expect(fetcher).not.toHaveBeenCalled();

            storage.map.set('a', 'updated-in-storage'); // shows up out-of-band — must stay unread
            await expect(cache.get('a')).resolves.toBe('from-storage');
            expect(fetcher).not.toHaveBeenCalled();
        },
    );

    test('a subclass overriding shouldReadStorage decides whether storage is read', async () => {
        class AlwaysReadExtension<T> extends StorageCacheExtension<T> {
            protected override shouldReadStorage(): boolean {
                return true;
            }
        }

        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(new AlwaysReadExtension(storage));

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();

        // the subclass ignores `refreshing` too, so even refresh() reads storage
        await expect(cache.refresh('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('a storage-hit get() superseded by refresh() ends up with storage holding the refresh result', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => delayedValue(10, `fresh-${key}`));
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        const getPromise = cache.get('a');
        const refreshPromise = cache.refresh('a');

        await vi.advanceTimersByTimeAsync(10);
        await Promise.all([getPromise, refreshPromise]);

        expect(cache.getCurrent('a', false)).toBe('fresh-a');
        expect(storage.map.get('a')).toBe('fresh-a');
    });

    test('a stale value with a failed refresh() stays a cache hit: expiring it reads the fetcher, not storage', async () => {
        const storage = new FakeStorage<string>();

        let shouldFail = false;
        const fetcher = vi.fn(async (key: string) => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return `fetched-${key}`;
        });
        const cache = new PromiseCache<string>(fetcher)
            .extend(createStorageCacheExtension(storage))
            .useInvalidation({ expirationMs: 100 });

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);

        shouldFail = true;
        await cache.refresh('a'); // fails — error stored, stale value kept
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        expect(cache.getCurrent('a', false)).toBe('fetched-a');

        shouldFail = false;
        storage.map.set('a', 'from-storage'); // present in storage — must be bypassed, the cache has a value

        cache.expire('a');
        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(3);

        // same check via TTL lapse instead of expire()
        shouldFail = true;
        await cache.refresh('a');
        await vi.advanceTimersByTimeAsync(101);
        shouldFail = false;
        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(5);
    });

    test('an errored key with no cached value reads the fetcher, not storage, after expire()', async () => {
        const storage = new FakeStorage<string>();

        let shouldFail = true;
        const fetcher = vi.fn(async (key: string) => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return `fetched-${key}`;
        });
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        // storage is empty, so this cold read falls through to the fetcher and fails
        await cache.get('a');
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        // a value shows up in storage out-of-band, but the error must still block the storage read
        storage.map.set('a', 'from-storage');
        cache.expire('a');

        shouldFail = false;
        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('expire() during a first-ever fetch sends the next read to the fetcher, not to storage', async () => {
        const storage = new FakeStorage<string>();

        const fetcher = vi.fn(async (key: string) => delayedValue(10, `fetched-${key}`));
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        const p = cache.get('a'); // first-ever fetch for this key, still in flight
        cache.expire('a'); // marks it stale; the in-flight fetch is unaffected

        await vi.advanceTimersByTimeAsync(10);
        await expect(p).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);

        storage.map.set('a', 'from-storage'); // shows up out-of-band after the fetch stored its result

        const p2 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await expect(p2).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('a subclass overriding shouldRemove to false keeps the key in storage across delete() and sanitize()', async () => {
        class KeepInStorageExtension<T> extends StorageCacheExtension<T> {
            protected override shouldRemove(): boolean {
                return false;
            }
        }

        const storage = new FakeStorage<string>();
        const cache = new PromiseCache<string>(async key => `fetched-${key}`)
            .extend(new KeepInStorageExtension(storage))
            .useInvalidation({ expirationMs: 100 });

        await cache.get('a');
        await cache.get('b');
        expect(storage.map.get('a')).toBe('fetched-a');
        expect(storage.map.get('b')).toBe('fetched-b');

        cache.delete('a');
        expect(storage.map.has('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(101);
        cache.sanitize();
        expect(storage.map.has('b')).toBe(true);
    });

    test('a wrapper above the storage extension that retries a storage hit still writes the network result back', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend(createStorageCacheExtension(storage))
            .extend({
                overrideFetcher: () => request => {
                    return Promise.resolve(request.next()).then(value => {
                        if (value === 'from-storage') {
                            // the storage hit didn't validate — force a network fetch within the same attempt
                            return request.next({ refreshing: true });
                        }
                        return value;
                    });
                },
            });

        const stored = vi.fn();
        cache.onStored.on(stored);

        await expect(cache.get('a')).resolves.toBe('fetched-a');

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(stored).toHaveBeenCalledTimes(1);
        expect(storage.map.get('a')).toBe('fetched-a'); // network result written back, not skipped as a storage echo
    });
});
