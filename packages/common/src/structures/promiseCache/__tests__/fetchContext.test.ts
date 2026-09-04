
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FetchContext, PromiseCacheKeyState } from '../index.js';
import { PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

describe('PromiseCache fetch request and context', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('an overrideFetcher wrapper receives key, refreshing flag, and a per-attempt context object', async () => {
        const requests: { key: string; refreshing: boolean; context: FetchContext }[] = [];

        const cache = new PromiseCache<string>(async key => `fetched-${key}`)
            .extend({
                overrideFetcher: () => request => {
                    requests.push({ key: request.key, refreshing: request.refreshing, context: request.context });
                    return request.next();
                },
            });

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        await expect(cache.refresh('a')).resolves.toBe('fetched-a');

        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({ key: 'a', refreshing: false });
        expect(requests[1]).toMatchObject({ key: 'a', refreshing: true });
        // each attempt gets its own context
        expect(requests[0].context).not.toBe(requests[1].context);
    });

    test('returning without calling next() substitutes the result, and onStored receives the same context object', async () => {
        const Mark = Symbol('mark');
        let requestContext: FetchContext | undefined;
        const onStored = vi.fn((e: { context?: FetchContext }) => e.context);

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => request => {
                    requestContext = request.context;
                    request.context[Mark] = true;
                    return 'provided';
                },
                onStored,
            });

        await expect(cache.get('a')).resolves.toBe('provided');
        expect(fetcher).not.toHaveBeenCalled();

        expect(onStored).toHaveBeenCalledTimes(1);
        const storedContext = onStored.mock.results[0].value as FetchContext;
        expect(storedContext).toBe(requestContext);
        expect(storedContext[Mark]).toBe(true);
    });

    test('a throwing wrapper is recorded as the fetch error', async () => {
        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => () => {
                    throw new Error('wrapper failure');
                },
            });

        await expect(cache.get('a')).resolves.toBeUndefined();
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('a rejecting async wrapper is recorded as the fetch error', async () => {
        const cache = new PromiseCache<string>(async key => key)
            .extend({
                overrideFetcher: () => async () => {
                    throw new Error('async wrapper failure');
                },
            });

        await expect(cache.get('a')).resolves.toBeUndefined();
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
    });

    test('manual set() fires onStored with no context', async () => {
        const onStored = vi.fn();
        const cache = new PromiseCache<string>(async key => key).extend({ onStored });

        cache.set('a', 'manual');

        expect(onStored).toHaveBeenCalledTimes(1);
        expect(onStored.mock.calls[0][0].context).toBeUndefined();
    });

    test('wrappers chain newest-outermost, sharing one context, with the fetcher innermost', async () => {
        const calls: string[] = [];
        const contexts: FetchContext[] = [];

        const cache = new PromiseCache<string>(async key => {
            calls.push('fetcher');
            return `fetched-${key}`;
        })
            .extend({
                overrideFetcher: () => async request => {
                    calls.push('ext1:before');
                    contexts.push(request.context);
                    const res = await request.next();
                    calls.push('ext1:after');
                    return res;
                },
            })
            .extend({
                overrideFetcher: () => async request => {
                    calls.push('ext2:before');
                    contexts.push(request.context);
                    const res = await request.next();
                    calls.push('ext2:after');
                    return res;
                },
            });

        await expect(cache.get('a')).resolves.toBe('fetched-a');

        expect(calls).toEqual(['ext2:before', 'ext1:before', 'fetcher', 'ext1:after', 'ext2:after']);
        expect(contexts[0]).toBe(contexts[1]);
    });

    test('next({ refreshing }) changes what the inner chain sees for this attempt', async () => {
        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => request => request.next({ refreshing: false }),
            });

        await expect(cache.refresh('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledWith('a', false);
    });

    test('an async wrapper can call next() after awaiting — the context stays valid', async () => {
        const Mark = Symbol('mark');
        const storedContexts: (FetchContext | undefined)[] = [];

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => async request => {
                    const cached = await delayedValue<string | null>(10, null); // async storage miss
                    if (cached != null) {
                        return cached;
                    }
                    request.context[Mark] = true;
                    return request.next();
                },
                onStored: ({ context }) => {
                    storedContexts.push(context);
                },
            });

        const promise = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);

        await expect(promise).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(storedContexts).toHaveLength(1);
        expect(storedContexts[0]?.[Mark]).toBe(true);
    });

    test('contexts stay isolated across attempts: a superseding refresh() stores with its own context', async () => {
        const Mark = Symbol('mark');
        const storedContexts: (FetchContext | undefined)[] = [];

        const fetcher = vi.fn(async (key: string) => delayedValue(10, `fresh-${key}`));
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => request => {
                    if (!request.refreshing) {
                        request.context[Mark] = true;
                        return delayedValue(20, 'served');
                    }
                    return request.next();
                },
                onStored: ({ context }) => {
                    storedContexts.push(context);
                },
            });

        const getPromise = cache.get('a');
        const refreshPromise = cache.refresh('a');

        await vi.advanceTimersByTimeAsync(20);
        await Promise.all([getPromise, refreshPromise]);

        expect(cache.getCurrent('a', false)).toBe('fresh-a');
        expect(storedContexts).toHaveLength(1);
        expect(storedContexts[0]?.[Mark]).toBeUndefined();
    });

    test('a substituted result passes through prepareValue, and the context is still there when onStored fires', async () => {
        const contexts: (FetchContext | undefined)[] = [];

        const cache = new PromiseCache<string>(
            async key => `fetched-${key}`,
            { prepareValue: value => `prepared-${value}` },
        )
            .extend({
                overrideFetcher: () => request => {
                    request.context.provided = true;
                    return 'raw';
                },
                onStored: ({ context }) => {
                    contexts.push(context);
                },
            });

        await expect(cache.get('a')).resolves.toBe('prepared-raw');
        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.provided).toBe(true);
    });

    test('next() called twice re-runs the inner chain on the same context', async () => {
        const Mark = Symbol('mark');
        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const storedContexts: (FetchContext | undefined)[] = [];

        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => async request => {
                    request.context[Mark] = true;
                    await request.next();
                    return request.next();
                },
                onStored: ({ context }) => {
                    storedContexts.push(context);
                },
            });

        await expect(cache.get('a')).resolves.toBe('fetched-a');

        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(storedContexts).toHaveLength(1);
        expect(storedContexts[0]?.[Mark]).toBe(true);
    });

    test('a destructured next still works', async () => {
        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => request => {
                    const { next } = request;
                    return next();
                },
            });

        await expect(cache.get('a')).resolves.toBe('fetched-a');
    });

    test("request.state.invalidatedBy is 'forced' after expire()", async () => {
        const observed: (string | null)[] = [];
        const cache = new PromiseCache<string>(async key => `fetched-${key}`)
            .extend({
                overrideFetcher: () => request => {
                    observed.push(request.state.invalidatedBy);
                    return request.next();
                },
            });

        await cache.get('a');
        cache.expire('a');
        await cache.get('a');

        expect(observed).toEqual([null, 'forced']);
    });

    test('request.state.hasKey is false on a cold read, true on a revalidation', async () => {
        const observed: boolean[] = [];
        const cache = new PromiseCache<string>(async key => `fetched-${key}`)
            .extend({
                overrideFetcher: () => request => {
                    observed.push(request.state.hasKey);
                    return request.next();
                },
            });

        await cache.get('a');
        await cache.refresh('a');

        expect(observed).toEqual([false, true]);
    });

    test('state stays the same object across next()', async () => {
        let outerState: PromiseCacheKeyState | undefined;
        let innerState: PromiseCacheKeyState | undefined;

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: () => request => {
                    outerState = request.state;
                    return request.next();
                },
            })
            .extend({
                overrideFetcher: () => request => {
                    innerState = request.state;
                    return request.next();
                },
            });

        await expect(cache.get('a')).resolves.toBe('fetched-a');
        expect(innerState).toBe(outerState);
    });
});
