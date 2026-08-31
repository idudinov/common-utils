
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createEvictionExtension, PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

describe('PromiseCache eviction extension', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('evicts oldest items when limit is reached', async () => {
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        ).extend(createEvictionExtension({ maxItems: 3 }));

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

        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        )
            .useInvalidation({
                invalidationCheck: (key) => invalidKeys.has(key),
            })
            .extend(createEvictionExtension({ maxItems: 3 }));

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

        const cache = new PromiseCache<string>(
            async id => {
                await new Promise<void>(resolve => { resolvers[id] = resolve; });
                return id;
            },
        ).extend(createEvictionExtension({ maxItems: 2 }));

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
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        ).extend(createEvictionExtension({ maxItems: 2 }));

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
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        ).extend(createEvictionExtension({ maxItems: 2 }));

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
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        ).extend(createEvictionExtension({ maxItems: 3 }));

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
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        ).extend(createEvictionExtension({ maxItems: 3 }));

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
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, `${id}-${++counter}`),
        ).extend(createEvictionExtension({ maxItems: 3 }));

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

        // Refresh 'a' — should update its position to be newest
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

    // --- set() enforcement ---

    test('set() triggers eviction enforcement', () => {
        const cache = new PromiseCache<string>(
            async id => id,
        ).extend(createEvictionExtension({ maxItems: 2 }));

        // Each set() is its own onStored, so the third call evicts 'a' immediately.
        cache.set('a', 'val-a');
        cache.set('b', 'val-b');
        cache.set('c', 'val-c');

        expect(cache.cachedCount).toBe(2);
        expect(cache.hasKey('a')).toBe(false);
        expect(cache.hasKey('b')).toBe(true);
        expect(cache.hasKey('c')).toBe(true);
    });

    test('does not evict a stale value while its refresh is in flight', async () => {
        const resolvers: (() => void)[] = [];
        let counter = 0;

        const cache = new PromiseCache<string>(
            async id => {
                const value = `${id}-${++counter}`;
                await new Promise<void>(resolve => resolvers.push(resolve));
                return value;
            },
        ).extend(createEvictionExtension({ maxItems: 2 }));

        const pa = cache.get('a');
        resolvers.pop()!();
        await pa;

        const pb = cache.get('b');
        resolvers.pop()!();
        await pb;

        // Start refreshing 'a' — it keeps its stale value while in flight
        const refreshPromise = cache.refresh('a');

        // Adding 'c' should not evict 'a' even though it's the oldest, since it's in flight
        const pc = cache.get('c');
        resolvers.pop()!();
        await pc;

        expect(cache.hasKey('a')).toBe(true);
        expect(cache.hasKey('b')).toBe(false);
        expect(cache.hasKey('c')).toBe(true);

        resolvers.pop()!();
        await refreshPromise;
    });

    test('evicts entries cached before extend() attaches', async () => {
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        );

        let p = cache.get('a');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        const evictingCache = cache.extend(createEvictionExtension({ maxItems: 1 }));

        p = evictingCache.get('b');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        expect(evictingCache.keys()).toEqual(['b']);
    });

    test('ghost keys (removed behind the extension\'s back) do not block or stall eviction', async () => {
        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        ).extend(createEvictionExtension({ maxItems: 2 }));

        let p = cache.get('a');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        p = cache.get('b');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        // Removed silently, so the extension's `order` still holds 'a' as a ghost entry.
        cache.invalidate('a', 'silent');

        p = cache.get('c');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        p = cache.get('d');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        expect(cache.cachedCount).toBe(2);
        expect(cache.keys().sort()).toEqual(['c', 'd']);
    });

    test('onInvalidated of another extension does not fire on eviction, but does on a direct invalidate()', async () => {
        const onInvalidated = vi.fn();

        const cache = new PromiseCache<string>(
            async id => delayedValue(5, id),
        )
            .extend({ onInvalidated })
            .extend(createEvictionExtension({ maxItems: 1 }));

        let p = cache.get('a');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        // Evicted by the next store — the other extension's onInvalidated must stay silent
        p = cache.get('b');
        await vi.advanceTimersByTimeAsync(5);
        await p;

        expect(cache.hasKey('a')).toBe(false);
        expect(cache.hasKey('b')).toBe(true);
        expect(onInvalidated).not.toHaveBeenCalled();

        // A direct, default-mode invalidate() still notifies
        cache.invalidate('b');
        expect(onInvalidated).toHaveBeenCalledTimes(1);
        expect(onInvalidated).toHaveBeenCalledWith('b', cache);
    });
});
