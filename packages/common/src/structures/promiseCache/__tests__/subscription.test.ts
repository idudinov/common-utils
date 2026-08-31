
import type { DisposeFunction } from '../../../functions/disposer.js';
import { createSubscriptionExtension, PromiseCache, SHORT_SUBSCRIPTION_TTL_MS } from '../index.js';

describe('PromiseCache subscription extension', () => {

    test('first emission resolves get(key), subscribe runs exactly once', async () => {
        const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
            emit('v1');
            return () => { /* no-op */ };
        });
        const ext = createSubscriptionExtension<string>(subscribe);
        const cache = new PromiseCache<string>(ext.fetch).extend(ext);

        await expect(cache.get('a')).resolves.toBe('v1');
        expect(subscribe).toHaveBeenCalledTimes(1);
    });

    test('later emissions update getCurrent(key)', async () => {
        let emit!: (v: string) => void;
        const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
            emit = e;
            e('v1');
            return () => { /* no-op */ };
        });
        const ext = createSubscriptionExtension<string>(subscribe, 'forever');
        const cache = new PromiseCache<string>(ext.fetch).extend(ext);

        await cache.get('a');
        expect(cache.getCurrent('a', false)).toBe('v1');

        emit('v2');
        expect(cache.getCurrent('a', false)).toBe('v2');
    });

    test('concurrent get/getLazy for one key subscribe once during the first load', async () => {
        let resolveEmit!: (v: string) => void;
        const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
            resolveEmit = emit;
            return () => { /* no-op */ };
        });
        const ext = createSubscriptionExtension<string>(subscribe, 'forever');
        const cache = new PromiseCache<string>(ext.fetch).extend(ext);

        const p1 = cache.get('a');
        const p2 = cache.get('a');
        const lazy = cache.getLazy('a');
        void lazy.value;

        resolveEmit('v1');

        await expect(p1).resolves.toBe('v1');
        await expect(p2).resolves.toBe('v1');
        expect(subscribe).toHaveBeenCalledTimes(1);
    });

    describe("'off' policy", () => {
        test('unsubscribes right away when subscribe returns the unsub synchronously', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                emit('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'off');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await expect(cache.get('a')).resolves.toBe('v1');

            expect(unsub).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
            expect(cache.getCurrent('a', false)).toBe('v1');
        });

        test('unsubscribes once the async unsub resolves, after a synchronous first emission', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn(async (_key: string, emit: (v: string) => void) => {
                emit('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'off');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await expect(cache.get('a')).resolves.toBe('v1');

            expect(unsub).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
        });

        test('ignores a second synchronous emission arriving before the unsub', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn(async (_key: string, emit: (v: string) => void) => {
                emit('v1');
                emit('v2');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'off');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await expect(cache.get('a')).resolves.toBe('v1');

            expect(cache.getCurrent('a', false)).toBe('v1');
            expect(unsub).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
        });

        test('unsubscribes immediately when the unsub is already known by the time of the first emission', async () => {
            const unsub = vi.fn();
            let emit!: (v: string) => void;
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                emit = e;
                return Promise.resolve(unsub);
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'off');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            const p = cache.get('a');
            await Promise.resolve();
            await Promise.resolve();
            emit('v1');

            await expect(p).resolves.toBe('v1');
            expect(unsub).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
        });
    });

    describe("'forever' policy", () => {
        test('stays subscribed long after the first emission', async () => {
            vi.useFakeTimers();
            try {
                const unsub = vi.fn();
                const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                    emit('v1');
                    return unsub;
                });
                const ext = createSubscriptionExtension<string>(subscribe, 'forever');
                const cache = new PromiseCache<string>(ext.fetch).extend(ext);

                await cache.get('a');
                await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

                expect(unsub).not.toHaveBeenCalled();
                expect(ext.observedCount).toBe(1);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('{ ttlMs } policy', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        test('SHORT_SUBSCRIPTION_TTL_MS is 5 minutes', () => {
            expect(SHORT_SUBSCRIPTION_TTL_MS).toBe(5 * 60 * 1000);
        });

        test('resets on each emission; expiry unsubscribes and invalidates; the next read re-subscribes', async () => {
            const unsub = vi.fn();
            let emit!: (v: string) => void;
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                emit = e;
                e('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, { ttlMs: 1000 });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            expect(ext.observedCount).toBe(1);

            await vi.advanceTimersByTimeAsync(600);
            emit('v2');
            await vi.advanceTimersByTimeAsync(600);

            expect(unsub).not.toHaveBeenCalled();
            expect(cache.getCurrent('a', false)).toBe('v2');

            await vi.advanceTimersByTimeAsync(500);

            expect(unsub).toHaveBeenCalledTimes(1);
            expect(cache.hasKey('a')).toBe(false);
            expect(ext.observedCount).toBe(0);

            subscribe.mockClear();

            const p = cache.get('a');
            expect(subscribe).toHaveBeenCalledTimes(1);
            await p;
        });

        test('invalidate() before expiry clears the pending timer', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                emit('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, { ttlMs: 1000 });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            cache.invalidate('a');
            expect(unsub).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(2000);
            expect(unsub).toHaveBeenCalledTimes(1);
        });
    });

    describe('failures', () => {
        test('fetch rejects when the extension was never applied via extend()', async () => {
            const ext = createSubscriptionExtension<string>((_key, emit) => {
                emit('v1');
                return () => { /* no-op */ };
            });

            await expect(ext.fetch('a')).rejects.toThrow(/extend/);
        });

        test('a synchronous throw in subscribe rejects the fetch and stores the error', async () => {
            const error = new Error('sync throw');
            const subscribe = vi.fn(() => { throw error; });
            const ext = createSubscriptionExtension<string>(subscribe);
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');

            expect(cache.getLastError('a')).toBe(error);
            expect(ext.observedCount).toBe(0);
        });

        test('a rejected Promise<DisposeFunction> rejects the fetch and stores the error', async () => {
            const error = new Error('rejected unsub promise');
            const subscribe = vi.fn(() => Promise.reject<DisposeFunction>(error));
            const ext = createSubscriptionExtension<string>(subscribe);
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');

            expect(cache.getLastError('a')).toBe(error);
            expect(ext.observedCount).toBe(0);
        });

        test('a late rejection for an already-superseded subscription does not affect the current one', async () => {
            const unsubNew = vi.fn();
            let rejectOld!: (err: unknown) => void;
            let calls = 0;
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                calls++;
                if (calls === 1) {
                    emit('v1');
                    return new Promise<DisposeFunction>((_resolve, reject) => {
                        rejectOld = reject;
                    });
                }
                emit('v2');
                return unsubNew;
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'forever');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await expect(cache.get('a')).resolves.toBe('v1');
            await expect(cache.refresh('a')).resolves.toBe('v2');

            rejectOld(new Error('late failure for the superseded subscription'));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(unsubNew).not.toHaveBeenCalled();
            expect(ext.observedCount).toBe(1);
        });

        test('a rejection arriving after the first emission only tears down, the fetch is already settled', async () => {
            const unsub = vi.fn();
            let rejectSource!: (err: unknown) => void;
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                emit('v1');
                return new Promise<DisposeFunction>((_resolve, reject) => {
                    rejectSource = reject;
                });
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'forever');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await expect(cache.get('a')).resolves.toBe('v1');
            expect(ext.observedCount).toBe(1);

            rejectSource(new Error('late failure'));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(unsub).not.toHaveBeenCalled();
            expect(cache.getLastError('a')).toBeNull();
            expect(cache.getCurrent('a', false)).toBe('v1');
            expect(ext.observedCount).toBe(0);
        });
    });

    describe('teardown paths', () => {
        test('ignores emissions arriving after the entry has been cancelled', async () => {
            let emit!: (v: string) => void;
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                emit = e;
                e('v1');
                return () => { /* no-op */ };
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'forever');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            cache.invalidate('a');

            expect(() => emit('v2')).not.toThrow();
            expect(cache.hasKey('a')).toBe(false);
        });

        test('invalidate(key) unsubscribes and drops observedCount', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                emit('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'forever');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            cache.invalidate('a');

            expect(unsub).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
        });

        test('clear() unsubscribes every key', async () => {
            const unsubs: Record<string, DisposeFunction> = { a: vi.fn(), b: vi.fn() };
            const subscribe = vi.fn((key: string, emit: (v: string) => void) => {
                emit(key);
                return unsubs[key];
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'forever');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            await cache.get('b');
            cache.clear();

            expect(unsubs.a).toHaveBeenCalledTimes(1);
            expect(unsubs.b).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
        });

        test('dispose() unsubscribes every key', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                emit('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, 'forever');
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            cache.dispose();

            expect(unsub).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
        });
    });

    test('refresh(key) unsubscribes the previous source and subscribes again', async () => {
        const unsub1 = vi.fn();
        const unsub2 = vi.fn();
        let calls = 0;
        const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
            calls++;
            emit(`v${calls}`);
            return calls === 1 ? unsub1 : unsub2;
        });
        const ext = createSubscriptionExtension<string>(subscribe, 'forever');
        const cache = new PromiseCache<string>(ext.fetch).extend(ext);

        await expect(cache.get('a')).resolves.toBe('v1');
        await expect(cache.refresh('a')).resolves.toBe('v2');

        expect(unsub1).toHaveBeenCalledTimes(1);
        expect(unsub2).not.toHaveBeenCalled();
        expect(subscribe).toHaveBeenCalledTimes(2);
    });

    test("an old entry's late-arriving unsub, after being superseded by refresh(), disposes without touching the new entry", async () => {
        const unsubOld = vi.fn();
        const unsubNew = vi.fn();
        let resolveOldUnsub!: (u: DisposeFunction) => void;
        let calls = 0;
        const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
            calls++;
            if (calls === 1) {
                emit('v1');
                return new Promise<DisposeFunction>(resolve => {
                    resolveOldUnsub = resolve;
                });
            }
            emit('v2');
            return unsubNew;
        });
        const ext = createSubscriptionExtension<string>(subscribe, 'forever');
        const cache = new PromiseCache<string>(ext.fetch).extend(ext);

        await expect(cache.get('a')).resolves.toBe('v1');
        expect(ext.observedCount).toBe(1);

        await expect(cache.refresh('a')).resolves.toBe('v2');
        expect(ext.observedCount).toBe(1);
        expect(unsubOld).not.toHaveBeenCalled();

        resolveOldUnsub(unsubOld);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(unsubOld).toHaveBeenCalledTimes(1);
        expect(unsubNew).not.toHaveBeenCalled();
        expect(ext.observedCount).toBe(1);
    });
});
