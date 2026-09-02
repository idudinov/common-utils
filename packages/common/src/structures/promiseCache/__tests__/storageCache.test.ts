
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IStorageSync } from '../../../storage/types.js';
import { Storages } from '../../../storage/wrappers.js';
import { createStorageCacheExtension, PromiseCache } from '../index.js';

/** In-memory sync storage fake, keyed like {@link IStorageSync}. */
class FakeStorage<T> implements IStorageSync<T | null> {
    readonly map = new Map<string, T | null>();
    getError: Error | null = null;

    getValue(key: string): T | null {
        if (this.getError) {
            throw this.getError;
        }
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

    test('cold cache + storage hit: fetcher not called, value served, no echo write', async () => {
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

    test('a storage read failure is treated as a miss: onError called, fetcher result still stored', async () => {
        const storage = new FakeStorage<string>();
        storage.getError = new Error('read boom');

        const onError = vi.fn();
        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend(createStorageCacheExtension(storage, { onError }));

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(storage.getError, 'a');

        storage.getError = null;
        expect(storage.map.get('a')).toBe('fetched-a');
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

    test('works with an async (IStorage) wrapper, not just sync storage', async () => {
        const syncStorage = new FakeStorage<string>();
        const asyncStorage = Storages.toAsync(syncStorage);

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher).extend(createStorageCacheExtension(asyncStorage));

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);

        // Write is fire-and-forget: it lands on the microtask queue, not necessarily before this line.
        await Promise.resolve();
        expect(syncStorage.map.get('a')).toBe('fetched-a');
    });
});
