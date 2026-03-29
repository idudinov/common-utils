
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

describe('PromiseCache invalidation', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('getIsValid', () => {
        test('returns false for non-cached items', () => {
            const cache = new PromiseCache<string, string>(async id => id);
            expect(cache.getIsValid('nonexistent')).toBe(false);
        });

        test('returns true for valid cached items', async () => {
            const cache = new PromiseCache<string, string>(async id => id);
            await cache.get('a');
            expect(cache.getIsValid('a')).toBe(true);
        });

        test('returns false for expired items', async () => {
            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidationTime(50);

            await cache.get('a');
            expect(cache.getIsValid('a')).toBe(true);

            await vi.advanceTimersByTimeAsync(60);
            expect(cache.getIsValid('a')).toBe(false);
        });

        test('returns false for callback-invalidated items', async () => {
            const invalidKeys = new Set<string>();

            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation({
                invalidationCheck: (key) => invalidKeys.has(key),
            });

            await cache.get('a');
            await cache.get('b');

            expect(cache.getIsValid('a')).toBe(true);
            expect(cache.getIsValid('b')).toBe(true);

            invalidKeys.add('a');

            expect(cache.getIsValid('a')).toBe(false);
            expect(cache.getIsValid('b')).toBe(true);
        });
    });

    describe('set', () => {
        test('sets a timestamp so time-based invalidation applies', async () => {
            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidationTime(50);

            cache.set('a', 'manual-value');
            expect(cache.getCurrent('a', false)).toBe('manual-value');
            expect(cache.getIsValid('a')).toBe(true);

            // After expiration, the manually set value should be invalidated
            await vi.advanceTimersByTimeAsync(60);
            expect(cache.getIsValid('a')).toBe(false);
            // Stale value still readable
            expect(cache.getCurrent('a', false)).toBe('manual-value');
        });

        test('is evictable by maxItems (has a timestamp for oldest-first eviction)', async () => {
            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation({ maxItems: 2 });

            // Manually set two values
            cache.set('a', 'val-a');
            await vi.advanceTimersByTimeAsync(5);
            cache.set('b', 'val-b');

            expect(cache.cachedCount).toBe(2);

            // Fetch a third — should evict 'a' (oldest)
            await cache.get('c');

            expect(cache.cachedCount).toBe(2);
            expect(cache.hasKey('a')).toBe(false);
            expect(cache.hasKey('b')).toBe(true);
            expect(cache.hasKey('c')).toBe(true);
        });

        test('clears previous error for the key', async () => {
            const cache = new PromiseCache<string, string>(async () => {
                throw new Error('fetch failed');
            });

            await cache.get('a');
            expect(cache.getLastError('a')).toBeInstanceOf(Error);

            cache.set('a', 'recovered');
            expect(cache.getLastError('a')).toBeNull();
            expect(cache.getCurrent('a', false)).toBe('recovered');
        });
    });

    describe('useInvalidation config', () => {
        test('supports expirationMs', async () => {
            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation({ expirationMs: 50 });

            await cache.get('a');
            expect(cache.getIsValid('a')).toBe(true);

            await vi.advanceTimersByTimeAsync(60);
            expect(cache.getIsValid('a')).toBe(false);
        });

        test('supports invalidationCheck callback with timestamp', async () => {
            let threshold = Date.now() + 100;

            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation({
                invalidationCheck: (_key, _value, cachedAt) => cachedAt < threshold,
            });

            threshold = Date.now() + 100;
            await cache.get('a');
            expect(cache.getIsValid('a')).toBe(false);

            threshold = Date.now() - 100;
            cache.invalidate('a');
            await cache.get('a');
            expect(cache.getIsValid('a')).toBe(true);
        });

        test('always keeps stale value during invalidation (stale-while-revalidate)', async () => {
            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation({ expirationMs: 50 });

            await cache.get('a');
            const value = cache.getCurrent('a', false);
            expect(value).toBe('a');

            await vi.advanceTimersByTimeAsync(60);

            // Stale value is always kept — stale-while-revalidate by default
            expect(cache.getCurrent('a', false)).toBe('a');
            expect(cache.getIsValid('a')).toBe(false);
        });

        test('config is not destructured (supports dynamic getters)', async () => {
            let expirationMs = 50;

            const config = {
                get expirationMs() { return expirationMs; },
            };

            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation(config);

            await cache.get('a');
            expect(cache.getIsValid('a')).toBe(true);

            await vi.advanceTimersByTimeAsync(60);
            expect(cache.getIsValid('a')).toBe(false);

            expirationMs = 1000;
            expect(cache.getIsValid('a')).toBe(true);
        });

        test('disabling invalidation with null', async () => {
            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation({ expirationMs: 50 });

            await cache.get('a');
            await vi.advanceTimersByTimeAsync(60);
            expect(cache.getIsValid('a')).toBe(false);

            cache.useInvalidation(null);
            expect(cache.getIsValid('a')).toBe(true);
        });
    });

    describe('sanitize', () => {
        test('removes invalidated items and returns count', async () => {
            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidationTime(50);

            await cache.get('a');
            await cache.get('b');
            await cache.get('c');

            expect(cache.cachedCount).toBe(3);
            expect(cache.sanitize()).toBe(0);

            await vi.advanceTimersByTimeAsync(60);

            expect(cache.invalidCount).toBe(3);
            expect(cache.sanitize()).toBe(3);
            expect(cache.cachedCount).toBe(0);
            expect(cache.invalidCount).toBe(0);
        });

        test('only removes invalid items, keeps valid ones', async () => {
            const invalidKeys = new Set<string>();

            const cache = new PromiseCache<string, string>(
                async id => id,
            ).useInvalidation({
                invalidationCheck: (key) => invalidKeys.has(key),
            });

            await cache.get('a');
            await cache.get('b');
            await cache.get('c');

            invalidKeys.add('a');
            invalidKeys.add('c');

            expect(cache.sanitize()).toBe(2);
            expect(cache.cachedCount).toBe(1);
            expect(cache.hasKey('b')).toBe(true);
            expect(cache.hasKey('a')).toBe(false);
            expect(cache.hasKey('c')).toBe(false);
        });
    });

    describe('maxItems', () => {

        test('evicts oldest items when limit is reached', async () => {
            const cache = new PromiseCache<string, string>(
                async id => delayedValue(5, id),
            ).useInvalidation({ maxItems: 3 });

            let p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('b');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('c');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.cachedCount).toBe(3);

            p = cache.get('d');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.cachedCount).toBe(3);
            expect(cache.hasKey('a')).toBe(false);
            expect(cache.hasKey('b')).toBe(true);
            expect(cache.hasKey('c')).toBe(true);
            expect(cache.hasKey('d')).toBe(true);
        });

        test('evicts invalid items first before valid ones', async () => {
            const invalidKeys = new Set<string>();

            const cache = new PromiseCache<string, string>(
                async id => delayedValue(5, id),
            ).useInvalidation({
                maxItems: 3,
                invalidationCheck: (key) => invalidKeys.has(key),
            });

            let p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('b');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('c');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            invalidKeys.add('b');

            p = cache.get('d');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.cachedCount).toBe(3);
            expect(cache.hasKey('a')).toBe(true);
            expect(cache.hasKey('b')).toBe(false);
            expect(cache.hasKey('c')).toBe(true);
            expect(cache.hasKey('d')).toBe(true);
        });

        test('does not evict in-flight items', async () => {
            const resolvers: Record<string, () => void> = {};

            const cache = new PromiseCache<string, string>(
                async id => {
                    await new Promise<void>(resolve => { resolvers[id] = resolve; });
                    return id;
                },
            ).useInvalidation({ maxItems: 2 });

            const pa = cache.get('a');
            const pb = cache.get('b');

            resolvers.a();
            await pa;

            resolvers.b();
            await pb;

            expect(cache.cachedCount).toBe(2);

            const pc = cache.get('c');
            resolvers.c();
            await pc;

            expect(cache.cachedCount).toBe(2);
            expect(cache.hasKey('a')).toBe(false);
            expect(cache.hasKey('b')).toBe(true);
            expect(cache.hasKey('c')).toBe(true);
        });

        test('multiple sequential evictions maintain correct order', async () => {
            const cache = new PromiseCache<string, string>(
                async id => delayedValue(5, id),
            ).useInvalidation({ maxItems: 2 });

            // Fill cache: a, b
            let p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('b');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            // Add c → evicts a (oldest)
            p = cache.get('c');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.hasKey('a')).toBe(false);
            expect(cache.hasKey('b')).toBe(true);
            expect(cache.hasKey('c')).toBe(true);

            // Add d → evicts b (now oldest)
            p = cache.get('d');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.hasKey('b')).toBe(false);
            expect(cache.hasKey('c')).toBe(true);
            expect(cache.hasKey('d')).toBe(true);

            // Add e → evicts c (now oldest)
            p = cache.get('e');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.hasKey('c')).toBe(false);
            expect(cache.hasKey('d')).toBe(true);
            expect(cache.hasKey('e')).toBe(true);
        });

        test('eviction order resets after clear()', async () => {
            const cache = new PromiseCache<string, string>(
                async id => delayedValue(5, id),
            ).useInvalidation({ maxItems: 2 });

            // Fill cache: a, b
            let p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('b');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            cache.clear();

            // Re-fill: b first, then a
            p = cache.get('b');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            // Add c → should evict b (now oldest after clear)
            p = cache.get('c');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.hasKey('b')).toBe(false);
            expect(cache.hasKey('a')).toBe(true);
            expect(cache.hasKey('c')).toBe(true);
        });

        test('invalidate + re-fetch updates eviction order', async () => {
            const cache = new PromiseCache<string, string>(
                async id => delayedValue(5, id),
            ).useInvalidation({ maxItems: 3 });

            // Fill cache: a, b, c
            let p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('b');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('c');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            // Invalidate 'a' and re-fetch it — now 'a' should be newest
            cache.invalidate('a');
            p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            // Add d → should evict 'b' (oldest), not 'a' (re-fetched)
            p = cache.get('d');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.hasKey('a')).toBe(true);
            expect(cache.hasKey('b')).toBe(false);
            expect(cache.hasKey('c')).toBe(true);
            expect(cache.hasKey('d')).toBe(true);
        });

        test('set() items are evictable in correct order', async () => {
            const cache = new PromiseCache<string, string>(
                async id => delayedValue(5, id),
            ).useInvalidation({ maxItems: 3 });

            // Manually set two items
            cache.set('a', 'val-a');
            await vi.advanceTimersByTimeAsync(5);
            cache.set('b', 'val-b');

            // Fetch a third
            let p = cache.get('c');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.cachedCount).toBe(3);

            // Add d → should evict 'a' (oldest set() item)
            p = cache.get('d');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.cachedCount).toBe(3);
            expect(cache.hasKey('a')).toBe(false);
            expect(cache.hasKey('b')).toBe(true);
            expect(cache.hasKey('c')).toBe(true);
            expect(cache.hasKey('d')).toBe(true);
        });

        test('refresh() updates eviction timestamp', async () => {
            let counter = 0;
            const cache = new PromiseCache<string, string>(
                async id => delayedValue(5, `${id}-${++counter}`),
            ).useInvalidation({ maxItems: 3 });

            // Fill cache: a, b, c
            let p = cache.get('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('b');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            p = cache.get('c');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            // Refresh 'a' — should update its timestamp to be newest
            p = cache.refresh('a');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            // Add d → should evict 'b' (oldest), not 'a' (refreshed)
            p = cache.get('d');
            await vi.advanceTimersByTimeAsync(5);
            await p;

            expect(cache.hasKey('a')).toBe(true);
            expect(cache.hasKey('b')).toBe(false);
            expect(cache.hasKey('c')).toBe(true);
            expect(cache.hasKey('d')).toBe(true);
        });
    });
});
