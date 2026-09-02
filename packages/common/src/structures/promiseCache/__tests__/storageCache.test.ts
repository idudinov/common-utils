
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

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(storage));

        await expect(cache.get('a')).resolves.toBe('from-storage');
        expect(fetcher).not.toHaveBeenCalled();
        expect(cache.getCurrent('a', false)).toBe('from-storage');
        expect(storage.map.get('a')).toBe('from-storage');
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
});
