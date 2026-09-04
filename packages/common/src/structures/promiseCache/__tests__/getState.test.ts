
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

describe('PromiseCache getState', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('an unknown key reports an empty, invalid state', () => {
        const cache = new PromiseCache<string>(async id => id);

        expect(cache.getState('a')).toEqual({
            hasKey: false,
            hasValue: false,
            isValid: false,
            invalidatedBy: null,
            error: null,
            stampedAt: undefined,
        });
    });

    test('a resolved key with no invalidation configured is valid, with a stamped time', async () => {
        const cache = new PromiseCache<string>(async id => id);

        await cache.get('a');
        const state = cache.getState('a');

        expect(state).toMatchObject({
            hasKey: true,
            hasValue: true,
            isValid: true,
            invalidatedBy: null,
            error: null,
        });
        expect(state.stampedAt).toBe(Date.now());
    });

    test('a key mid-fetch reports no value yet', async () => {
        const cache = new PromiseCache<string>(async (id: string) => delayedValue(50, id));

        const p = cache.get('a');
        const state = cache.getState('a');

        expect(state).toMatchObject({
            hasKey: true,
            hasValue: false,
            isValid: false,
            invalidatedBy: null,
            error: null,
        });
        expect(state.stampedAt).toBeUndefined();

        await vi.advanceTimersByTimeAsync(50);
        await p;
    });

    test('a key with a stored error reports it, and stays invalid with no invalidatedBy reason', async () => {
        const cache = new PromiseCache<string>(async () => {
            throw new Error('boom');
        });

        await cache.get('a');
        const state = cache.getState('a');

        expect(state.hasValue).toBe(false);
        expect(state.isValid).toBe(false);
        expect(state.invalidatedBy).toBeNull();
        expect(state.error).toBeInstanceOf(Error);
    });

    describe('invalidatedBy', () => {
        test("'forced' after expire()", async () => {
            const cache = new PromiseCache<string>(async id => id);

            await cache.get('a');
            cache.expire('a');

            const state = cache.getState('a');
            expect(state.hasValue).toBe(true);
            expect(state.isValid).toBe(false);
            expect(state.invalidatedBy).toBe('forced');
        });

        test('is computed independently of a cached value: a pending, never-resolved key still reports \'forced\'', async () => {
            const cache = new PromiseCache<string>(async (id: string) => delayedValue(50, id));

            const p = cache.get('a');
            cache.expire('a');

            const state = cache.getState('a');
            expect(state.hasValue).toBe(false);
            expect(state.invalidatedBy).toBe('forced');

            await vi.advanceTimersByTimeAsync(50);
            await p;
        });

        test("'time' once the TTL lapses", async () => {
            const cache = new PromiseCache<string>(async id => id).useInvalidation({ expirationMs: 50 });

            await cache.get('a');
            expect(cache.getState('a').invalidatedBy).toBeNull();

            await vi.advanceTimersByTimeAsync(60);
            expect(cache.getState('a').invalidatedBy).toBe('time');
        });

        test("'check' when invalidationCheck rejects the value", async () => {
            let reject = false;
            const cache = new PromiseCache<string>(async id => id).useInvalidation({
                invalidationCheck: () => reject,
            });

            await cache.get('a');
            expect(cache.getState('a').invalidatedBy).toBeNull();

            reject = true;
            expect(cache.getState('a').invalidatedBy).toBe('check');
        });

        test('runs invalidationCheck once per getState() call, not once per field', async () => {
            const invalidationCheck = vi.fn(() => true);
            const cache = new PromiseCache<string>(async id => id).useInvalidation({ invalidationCheck });

            await cache.get('a');
            invalidationCheck.mockClear();

            const state = cache.getState('a');

            expect(state.isValid).toBe(false);
            expect(state.invalidatedBy).toBe('check');
            expect(invalidationCheck).toHaveBeenCalledTimes(1);
        });
    });
});
