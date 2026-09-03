
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PromiseCache } from '../index.js';

describe('PromiseCache events', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('onStored fires on set() and on a resolving fetch, with the prepared value', async () => {
        const onStored = vi.fn();

        const cache = new PromiseCache<string>(
            async key => key.toUpperCase(),
            { prepareValue: v => `${v}!` },
        );
        cache.onStored.on(onStored);

        await expect(cache.get('a')).resolves.toBe('A!');
        expect(onStored).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: 'a', value: 'A!' }));

        cache.set('b', 'raw');
        expect(onStored).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: 'b', value: 'raw!' }));

        expect(onStored).toHaveBeenCalledTimes(2);
    });

    test('onRemoved fires for delete() and sanitize(), never for clear()', async () => {
        const onRemoved = vi.fn();

        const cache = new PromiseCache<string>(async key => key).useInvalidation({ expirationMs: 10 });
        cache.onRemoved.on(onRemoved);

        await cache.get('b');
        await vi.advanceTimersByTimeAsync(20);
        cache.sanitize();
        expect(onRemoved).toHaveBeenCalledTimes(1);
        expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ key: 'b' }));

        await cache.get('c');
        cache.clear();
        expect(onRemoved).toHaveBeenCalledTimes(1);

        await cache.get('d');
        expect(cache.delete('d')).toBe(true);
        expect(onRemoved).toHaveBeenCalledTimes(2);
        expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ key: 'd' }));
    });

    test('delete() on an unknown key fires no onRemoved and returns false', () => {
        const onRemoved = vi.fn();

        const cache = new PromiseCache<string>(async key => key);
        cache.onRemoved.on(onRemoved);

        expect(cache.delete('never-fetched')).toBe(false);

        expect(onRemoved).not.toHaveBeenCalled();
    });

    test('delete() on a key holding only a stored error still fires onRemoved', async () => {
        const onRemoved = vi.fn();

        const cache = new PromiseCache<string>(async () => { throw new Error('fail'); });
        cache.onRemoved.on(onRemoved);

        await cache.get('a');
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        expect(cache.getHasValue('a')).toBe(false); // never stored a value, only an error

        expect(cache.delete('a')).toBe(true);

        expect(onRemoved).toHaveBeenCalledTimes(1);
        expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
    });

    test('onCleared fires on clear(), and also during dispose() (disposers run first, then clear())', async () => {
        const onCleared = vi.fn();
        const order: string[] = [];

        const cache = new PromiseCache<string>(async key => key)
            .extend({ dispose: () => order.push('extension-disposed') });
        cache.onCleared.on(() => { order.push('cleared'); onCleared(); });

        await cache.get('a');
        cache.clear();
        expect(onCleared).toHaveBeenCalledTimes(1);

        await cache.get('a');
        cache.dispose();
        expect(onCleared).toHaveBeenCalledTimes(2);
        expect(order).toEqual(['cleared', 'extension-disposed', 'cleared']);
    });

    test('.on() returns a working unsubscribe', async () => {
        const onStored = vi.fn();

        const cache = new PromiseCache<string>(async key => key);
        const unsubscribe = cache.onStored.on(onStored);

        await cache.get('a');
        expect(onStored).toHaveBeenCalledTimes(1);

        unsubscribe();

        await cache.get('b');
        expect(onStored).toHaveBeenCalledTimes(1);
    });

    test('a throwing handler does not break the cache operation or the other handlers', async () => {
        const good = vi.fn();
        const errorLog = vi.fn();

        const cache = new PromiseCache<string>(async key => key)
            .setLogger({ log: vi.fn(), warn: vi.fn(), error: errorLog });

        cache.onStored.on(() => { throw new Error('boom'); });
        cache.onStored.on(good);

        await expect(cache.get('a')).resolves.toBe('a');

        expect(good).toHaveBeenCalledWith(expect.objectContaining({ key: 'a', value: 'a' }));
        expect(cache.getCurrent('a', false)).toBe('a');
        expect(errorLog).toHaveBeenCalled();
    });
});
