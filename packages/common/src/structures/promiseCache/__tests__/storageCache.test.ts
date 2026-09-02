
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IStorageSync } from '../../../storage/types.js';
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

describe('PromiseCache storage cache extension', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('cold cache + storage hit: fetcher not called, value served, written back', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');
        const setValueSpy = vi.spyOn(storage, 'setValue');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();
        expect(cache.getCurrent('a', false)).toBe('from-storage');
        expect(setValueSpy).toHaveBeenCalledWith('a', 'from-storage');
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

    test('useInvalidation({ expirationMs }) with the extension refetches instead of reading storage once expired', async () => {
        const storage = new FakeStorage<string>();
        storage.map.set('a', 'from-storage');

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend(createStorageCacheExtension(storage))
            .useInvalidation({ expirationMs: 100 });

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(101);

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
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

    // Known limitation: a force-expired key that never held a cached value looks cold again, so the
    // gate reads storage instead of calling the fetcher; refresh() is the workaround.
    test.fails('expire() before the first cached value forces a fetcher call', async () => {
        const storage = new FakeStorage<string>();

        const fetcher = vi.fn(async (key: string) => delayedValue(10, `fetched-${key}`));
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        const p = cache.get('a'); // first-ever fetch for this key, still in flight
        cache.expire('a'); // abandons it — its result is discarded, never stored

        await vi.advanceTimersByTimeAsync(10);
        await p;

        storage.map.set('a', 'from-storage'); // shows up out-of-band before the retry

        await cache.get('a');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
