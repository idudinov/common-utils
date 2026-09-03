
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FetchContext } from '../index.js';
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
                overrideFetcher: original => request => {
                    requests.push({ key: request.key, refreshing: request.refreshing, context: request.context });
                    return original(request);
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

    test('returning without calling original substitutes the result, and onStored receives the same context object', async () => {
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
                overrideFetcher: original => async request => {
                    calls.push('ext1:before');
                    contexts.push(request.context);
                    const res = await original(request);
                    calls.push('ext1:after');
                    return res;
                },
            })
            .extend({
                overrideFetcher: original => async request => {
                    calls.push('ext2:before');
                    contexts.push(request.context);
                    const res = await original(request);
                    calls.push('ext2:after');
                    return res;
                },
            });

        await expect(cache.get('a')).resolves.toBe('fetched-a');

        expect(calls).toEqual(['ext2:before', 'ext1:before', 'fetcher', 'ext1:after', 'ext2:after']);
        expect(contexts[0]).toBe(contexts[1]);
    });

    test('a rebuilt request keeping the same context passes the health check', async () => {
        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: original => request =>
                    original({ key: request.key, refreshing: false, context: request.context }),
            });

        await expect(cache.refresh('a')).resolves.toBe('fetched-a');
        expect(fetcher).toHaveBeenCalledWith('a', false);
    });

    test('a wrapper passing down a foreign context fails the fetch', async () => {
        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: original => request =>
                    original({ ...request, context: {} }),
            });

        await expect(cache.get('a')).resolves.toBeUndefined();
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
        expect((cache.getLastError('a') as Error).message).toMatch(/context/);
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('a wrapper passing down a cloned context fails the fetch — marks in a clone would never reach onStored', async () => {
        const cache = new PromiseCache<string>(async key => key)
            .extend({
                overrideFetcher: original => request =>
                    original({ ...request, context: { ...request.context } }),
            });

        await expect(cache.get('a')).resolves.toBeUndefined();
        expect(cache.getLastError('a')).toBeInstanceOf(Error);
    });

    test('an async wrapper can call original() after awaiting — the context stays valid', async () => {
        const Mark = Symbol('mark');
        const storedContexts: (FetchContext | undefined)[] = [];

        const fetcher = vi.fn(async (key: string) => `fetched-${key}`);
        const cache = new PromiseCache<string>(fetcher)
            .extend({
                overrideFetcher: original => async request => {
                    const cached = await delayedValue<string | null>(10, null); // async storage miss
                    if (cached != null) {
                        return cached;
                    }
                    request.context[Mark] = true;
                    return original(request);
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
                overrideFetcher: original => request => {
                    if (!request.refreshing) {
                        request.context[Mark] = true;
                        return delayedValue(20, 'served');
                    }
                    return original(request);
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

    test('a substituted result passes through prepareValue, and the context still reaches onStored', async () => {
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
});
