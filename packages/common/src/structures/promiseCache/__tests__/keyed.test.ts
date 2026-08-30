
import { describe, test, expect, vi } from 'vitest';
import { KeyedPromiseCache } from '../keyed.js';
import { PromiseCache } from '../cache.js';

describe('KeyedPromiseCache', () => {

    describe('id translation', () => {
        test('fetcher receives the original id — registry-only (no fromKey)', async () => {
            const fetcher = vi.fn(async (id: number, refreshing?: boolean) => ({ id, refreshing: !!refreshing }));
            const cache = new KeyedPromiseCache(fetcher, id => id.toString());

            await expect(cache.get(42)).resolves.toEqual({ id: 42, refreshing: false });
            expect(fetcher).toHaveBeenCalledWith(42, false);

            await expect(cache.refresh(42)).resolves.toEqual({ id: 42, refreshing: true });
            expect(fetcher).toHaveBeenCalledWith(42, true);
        });

        test('fetcher receives the original id — with fromKey', async () => {
            const fetcher = vi.fn(async (id: number) => id * 10);
            const cache = new KeyedPromiseCache(fetcher, id => id.toString(), {
                fromKey: key => Number(key),
            });

            // fromKey resolves ids independently of the registry — works even for a key
            // never previously passed through one of this wrapper's own methods.
            await expect(cache.cache.get('7')).resolves.toBe(70);
            expect(fetcher).toHaveBeenCalledWith(7, false);

            await expect(cache.get(3)).resolves.toBe(30);
            expect(fetcher).toHaveBeenCalledWith(3, false);
        });

        test('registry-only mode: a key never registered via a public method cannot be resolved by the fetcher', async () => {
            const fetcher = vi.fn(async (id: number) => id);
            const cache = new KeyedPromiseCache(fetcher, id => id.toString());

            // Bypass the wrapper and hit the inner cache with a key that was never registered.
            await expect(cache.cache.get('99')).resolves.toBeUndefined();
            expect(fetcher).not.toHaveBeenCalled();
            expect(cache.cache.getLastError('99')).toBeInstanceOf(Error);
            expect((cache.cache.getLastError('99') as Error).message).toMatch(/no id registered/);
        });
    });

    describe('getLazy', () => {
        test('handle round-trip stays consistent with the id-keyed API', async () => {
            const fetcher = vi.fn(async (id: number) => `value-${id}`);
            const cache = new KeyedPromiseCache(fetcher, id => id.toString());

            const lazy = cache.getLazy(5);
            expect(lazy.currentValue).toBeUndefined();
            expect(lazy.hasValue).toBe(false);

            await expect(lazy.promise).resolves.toBe('value-5');
            expect(lazy.value).toBe('value-5');
            expect(lazy.hasValue).toBe(true);

            expect(cache.getCurrent(5, false)).toBe('value-5');
            expect(cache.getHasValue(5)).toBe(true);

            const refreshed = await lazy.refresh();
            expect(refreshed).toBe('value-5');
            expect(fetcher).toHaveBeenCalledTimes(2);
        });

        test('accepts a per-handle loading state strategy', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            const lazy = cache.getLazy(1, { loading: false });
            expect(lazy.isLoading).toBeNull();

            void lazy.value;
            expect(lazy.isLoading).toBe(false); // overridden by the per-handle strategy

            await lazy.promise;
        });
    });

    describe('keys', () => {
        test('returns the original ids for cached keys', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            await cache.get(1);
            await cache.get(2);

            expect(cache.keys().slice().sort()).toEqual([1, 2]);
        });

        test('throws for a key with no registry entry and no fromKey', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            // Populate the inner cache directly, bypassing the wrapper's registration.
            cache.cache.set('7', 7);

            expect(() => cache.keys()).toThrow(/no id registered/);
        });

        test('resolves via fromKey when provided, regardless of registry state', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString(), {
                fromKey: key => Number(key),
            });

            cache.cache.set('7', 7);

            expect(cache.keys()).toEqual([7]);
        });

        test('raw inner keys are reachable via cache.keys()', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            await cache.get(1);
            await cache.get(2);

            expect(cache.cache.keys().slice().sort()).toEqual(['1', '2']);
        });

        test('iterator overload yields the original ids', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            await cache.get(1);
            await cache.get(2);

            expect(Array.from(cache.keys(true)).sort()).toEqual([1, 2]);
        });
    });

    describe('registry cleanup', () => {
        test('invalidate() removes the registry entry', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            await cache.get(3);
            expect(cache.keys()).toEqual([3]);

            cache.invalidate(3);
            expect(cache.cache.hasKey('3')).toBe(false); // inner cache cleared, bypassing the wrapper

            // The registry entry for '3' is gone — re-populating the inner cache directly
            // for the same string key now has no id to resolve back to.
            cache.cache.set('3', 999);
            expect(() => cache.keys()).toThrow(/no id registered/);
        });

        test('invalidate(id, \'silent\') forwards the mode to the inner cache and still removes the registry entry', async () => {
            const onInvalidated = vi.fn();
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());
            cache.cache.extend({ onInvalidated });

            await cache.get(4);
            cache.invalidate(4, 'silent');

            expect(onInvalidated).not.toHaveBeenCalled();
            expect(cache.cache.hasKey('4')).toBe(false);

            cache.cache.set('4', 999);
            expect(() => cache.keys()).toThrow(/no id registered/);
        });

        test('clear() empties the registry', async () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            await cache.get(1);
            await cache.get(2);

            cache.clear();
            expect(cache.keys()).toEqual([]);

            cache.cache.set('1', 111);
            expect(() => cache.keys()).toThrow(/no id registered/);
        });
    });

    describe('cacheFactory', () => {
        class CustomCache<T> extends PromiseCache<T> {
            readonly marker = 'custom';
        }

        test('uses the provided factory and exposes it via the cache getter', async () => {
            const fetcher = vi.fn(async (id: number) => id);
            const cache = new KeyedPromiseCache(fetcher, id => id.toString(), {
                cacheFactory: f => new CustomCache<number>(f),
            });

            expect(cache.cache).toBeInstanceOf(CustomCache);
            expect(cache.cache.marker).toBe('custom');

            await expect(cache.get(3)).resolves.toBe(3);
        });

        test('defaults to a plain PromiseCache when no factory is given', () => {
            const cache = new KeyedPromiseCache(async (id: number) => id, id => id.toString());

            expect(cache.cache).toBeInstanceOf(PromiseCache);
        });
    });
});
