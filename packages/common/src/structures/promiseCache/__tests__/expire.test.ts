
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

describe('PromiseCache.expire', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('marks a cached key stale without removing it, no events fired', async () => {
        const cache = new PromiseCache<string>(async id => id);

        const stored = vi.fn();
        const removed = vi.fn();
        const cleared = vi.fn();
        cache.onStored.on(stored);
        cache.onRemoved.on(removed);
        cache.onCleared.on(cleared);

        await cache.get('a');
        stored.mockClear();

        cache.expire('a');

        expect(cache.getIsValid('a')).toBe(false);
        expect(cache.getCurrent('a', false)).toBe('a');
        expect(stored).not.toHaveBeenCalled();
        expect(removed).not.toHaveBeenCalled();
        expect(cleared).not.toHaveBeenCalled();
    });

    test('next get() revalidates while serving the stale value, then settles as valid', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter));

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;
        expect(cache.getCurrent('a', false)).toBe(1);

        cache.expire('a');

        const p = cache.get('a');
        expect(cache.getPendingState('a')).toBe('revalidating');
        expect(cache.getCurrent('a', false)).toBe(1);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(cache.getCurrent('a', false)).toBe(2);
        expect(cache.getIsValid('a')).toBe(true);
    });

    test('failed refetch after expire() leaves the key invalid; next get() retries', async () => {
        let shouldFail = true;
        const cache = new PromiseCache<string>(async () => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 'recovered';
        });

        await cache.get('a');
        cache.expire('a');

        await cache.get('a');
        expect(cache.getIsValid('a')).toBe(false);

        shouldFail = false;
        const result = await cache.get('a');
        expect(result).toBe('recovered');
        expect(cache.getIsValid('a')).toBe(true);
    });

    test('expire() on an errored key (sticky error) makes the next get() refetch', async () => {
        let shouldFail = true;
        const cache = new PromiseCache<string>(async () => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 'recovered';
        });

        await cache.get('a');
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        cache.expire('a');
        shouldFail = false;

        const result = await cache.get('a');
        expect(result).toBe('recovered');
        expect(cache.getLastError('a')).toBeNull();
    });

    test('is a no-op for an unknown key', () => {
        const cache = new PromiseCache<string>(async id => id);

        cache.expire('unknown');

        expect(cache.hasKey('unknown')).toBe(false);
        expect(cache.delete('unknown')).toBe(false);
    });

    test('set() after expire() makes the key valid again', async () => {
        const cache = new PromiseCache<string>(async id => id);

        await cache.get('a');
        cache.expire('a');
        expect(cache.getIsValid('a')).toBe(false);

        cache.set('a', 'fresh');
        expect(cache.getIsValid('a')).toBe(true);
    });

    test('sanitize() removes force-expired keys and fires onRemoved', async () => {
        const cache = new PromiseCache<string>(async id => id);

        const removed: string[] = [];
        cache.onRemoved.on(({ key }) => { removed.push(key); });

        await cache.get('a');
        await cache.get('b');

        cache.expire('a');

        expect(cache.invalidCount).toBe(1);
        expect(cache.sanitize()).toBe(1);
        expect(cache.hasKey('a')).toBe(false);
        expect(cache.hasKey('b')).toBe(true);
        expect(removed).toEqual(['a']);
    });

    test('works with no InvalidationConfig configured', async () => {
        const cache = new PromiseCache<string>(async id => id);

        await cache.get('a');
        expect(cache.getIsValid('a')).toBe(true);

        cache.expire('a');
        expect(cache.getIsValid('a')).toBe(false);
    });

    test('invalidCount includes force-expired keys', async () => {
        const cache = new PromiseCache<string>(async id => id);

        await cache.get('a');
        await cache.get('b');
        expect(cache.invalidCount).toBe(0);

        cache.expire('a');
        expect(cache.invalidCount).toBe(1);
    });
});
