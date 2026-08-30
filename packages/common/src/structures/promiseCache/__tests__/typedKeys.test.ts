
import { describe, test, expect, vi } from 'vitest';
import { PromiseCache } from '../index.js';

type UserKey = `user:${string}`;

function userKey(id: string): UserKey {
    return `user:${id}`;
}

describe('PromiseCache typed keys', () => {
    test('fetcher and keys() carry the narrowed key type', async () => {
        const fetcher = vi.fn(async (key: UserKey) => `value-${key}`);
        const cache = new PromiseCache<string, UserKey>(fetcher);

        const result = await cache.get(userKey('42'));

        expect(result).toBe('value-user:42');
        expect(fetcher).toHaveBeenCalledWith('user:42', false);

        const keys: UserKey[] = cache.keys();
        expect(keys).toEqual(['user:42']);
    });

    test('rejects a plain string key at compile time', async () => {
        const cache = new PromiseCache<string, UserKey>(async (key) => key);

        // @ts-expect-error a plain `string` is not assignable to `user:${string}`
        cache.get('42');

        // @ts-expect-error a plain `string` is not assignable to `user:${string}`
        cache.set('42', 'x');

        await cache.get(userKey('42'));
    });
});
