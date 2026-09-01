
import type { DisposeFunction } from '../../../functions/disposer.js';
import { createEvictionExtension, createSubscriptionExtension, PromiseCache, SHORT_SUBSCRIPTION_TTL_MS } from '../index.js';

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
        const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
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
        const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
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
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'off' });
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
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'off' });
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
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'off' });
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
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'off' });
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
                const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
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

        test('resets on each emission; expiry unsubscribes and deletes; the next read re-subscribes', async () => {
            const unsub = vi.fn();
            let emit!: (v: string) => void;
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                emit = e;
                e('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: { ttlMs: 1000 } });
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

        test('delete() before expiry clears the pending timer', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                emit('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: { ttlMs: 1000 } });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            cache.delete('a');
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
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await expect(cache.get('a')).resolves.toBe('v1');
            await expect(cache.refresh('a')).resolves.toBe('v2');

            rejectOld(new Error('late failure for the superseded subscription'));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(unsubNew).not.toHaveBeenCalled();
            expect(ext.observedCount).toBe(1);
        });

        test('a rejection arriving after the first emission tears down and deletes — the key does not keep serving a value with no live source', async () => {
            const unsubNew = vi.fn();
            let rejectSource!: (err: unknown) => void;
            let calls = 0;
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                calls++;
                if (calls === 1) {
                    emit('v1');
                    return new Promise<DisposeFunction>((_resolve, reject) => {
                        rejectSource = reject;
                    });
                }
                emit('v2');
                return unsubNew;
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await expect(cache.get('a')).resolves.toBe('v1');
            expect(ext.observedCount).toBe(1);

            rejectSource(new Error('late failure'));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(cache.getLastError('a')).toBeNull();
            expect(cache.hasKey('a')).toBe(false);
            expect(cache.getCurrent('a', false)).toBeUndefined();
            expect(ext.observedCount).toBe(0);

            // a subsequent read re-subscribes rather than serving the now-dead value forever
            await expect(cache.get('a')).resolves.toBe('v2');
            expect(subscribe).toHaveBeenCalledTimes(2);
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
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            cache.delete('a');

            expect(() => emit('v2')).not.toThrow();
            expect(cache.hasKey('a')).toBe(false);
        });

        test('delete(key) unsubscribes and drops observedCount', async () => {
            const unsub = vi.fn();
            const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                emit('v1');
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            await cache.get('a');
            cache.delete('a');

            expect(unsub).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(0);
        });

        test('clear() unsubscribes every key', async () => {
            const unsubs: Record<string, DisposeFunction> = { a: vi.fn(), b: vi.fn() };
            const subscribe = vi.fn((key: string, emit: (v: string) => void) => {
                emit(key);
                return unsubs[key];
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
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
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
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
        const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
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
        const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
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

    describe('interaction with other extensions', () => {
        test('eviction of a subscribed key calls its unsub, drops observedCount, and a later emission does not resurrect it', async () => {
            const unsubs: Record<string, DisposeFunction> = {};
            let emitA!: (v: string) => void;
            const subscribe = vi.fn((key: string, emit: (v: string) => void) => {
                if (key === 'a') emitA = emit;
                emit(key);
                const unsub = vi.fn();
                unsubs[key] = unsub;
                return unsub;
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch)
                .extend(ext)
                .extend(createEvictionExtension({ maxItems: 1 }));

            await cache.get('a');
            await cache.get('b'); // evicts 'a'

            expect(unsubs.a).toHaveBeenCalledTimes(1);
            expect(ext.observedCount).toBe(1);
            expect(cache.hasKey('a')).toBe(false);

            emitA('a-late');
            expect(cache.hasKey('a')).toBe(false);
        });

        test('sanitize() of an expired subscribed key calls its unsub', async () => {
            vi.useFakeTimers();
            try {
                const unsub = vi.fn();
                const subscribe = vi.fn((_key: string, emit: (v: string) => void) => {
                    emit('v1');
                    return unsub;
                });
                const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
                const cache = new PromiseCache<string>(ext.fetch)
                    .extend(ext)
                    .useInvalidation({ expirationMs: 10 });

                await cache.get('a');
                await vi.advanceTimersByTimeAsync(20);
                expect(cache.sanitize()).toBe(1);

                expect(unsub).toHaveBeenCalledTimes(1);
                expect(ext.observedCount).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    test('a per-key policy function yields different policies per key', async () => {
        const unsubs: Record<string, DisposeFunction> = { a: vi.fn(), b: vi.fn() };
        const subscribe = vi.fn((key: string, emit: (v: string) => void) => {
            emit(key);
            return unsubs[key];
        });
        const ext = createSubscriptionExtension<string>(subscribe, {
            policy: key => (key === 'a' ? 'off' : 'forever'),
        });
        const cache = new PromiseCache<string>(ext.fetch).extend(ext);

        await cache.get('a');
        expect(unsubs.a).toHaveBeenCalledTimes(1); // 'off' unsubscribes right away

        await cache.get('b');
        expect(unsubs.b).not.toHaveBeenCalled(); // 'forever' stays subscribed
        expect(ext.observedCount).toBe(1);
    });

    test('merge preserves object identity across emissions', async () => {
        let emit!: (v: { count: number; name: string }) => void;
        const subscribe = vi.fn((_key: string, e: (v: { count: number; name: string }) => void) => {
            emit = e;
            e({ count: 1, name: 'a' });
            return () => { /* no-op */ };
        });
        const merge = vi.fn((current: { count: number; name: string }, incoming: { count: number; name: string }) => {
            Object.assign(current, incoming);
            return current;
        });
        const ext = createSubscriptionExtension(subscribe, { policy: 'forever', merge });
        const cache = new PromiseCache<{ count: number; name: string }>(ext.fetch).extend(ext);

        await cache.get('a');
        const first = cache.getCurrent('a', false);

        emit({ count: 2, name: 'a' });
        const second = cache.getCurrent('a', false);

        expect(second).toBe(first);
        expect(second).toEqual({ count: 2, name: 'a' });
        expect(merge).toHaveBeenCalledTimes(1);
    });

    describe('updates racing the not-yet-stored fetch result', () => {
        test('a same-tick delta after the resolving snapshot merges once the snapshot is stored', async () => {
            const subscribe = vi.fn((_key: string, e: (v: Record<string, number>) => void) => {
                e({ a: 1, b: 1 }); // snapshot — resolves the fetch
                e({ b: 2 }); // delta, same tick, before the cache stores the snapshot
                return () => { /* no-op */ };
            });
            const merge = vi.fn((cur: Record<string, number>, inc: Record<string, number>) => ({ ...cur, ...inc }));
            const ext = createSubscriptionExtension<Record<string, number>>(subscribe, { policy: 'forever', merge });
            const cache = new PromiseCache<Record<string, number>>(ext.fetch).extend(ext);

            await cache.get('k');

            expect(cache.getCurrent('k', false)).toEqual({ a: 1, b: 2 });
        });

        test('without merge, a same-tick delta replaces the snapshot wholesale', async () => {
            const subscribe = vi.fn((_key: string, e: (v: Record<string, number>) => void) => {
                e({ a: 1, b: 1 });
                e({ b: 2 });
                return () => { /* no-op */ };
            });
            const ext = createSubscriptionExtension<Record<string, number>>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<Record<string, number>>(ext.fetch).extend(ext);

            await cache.get('k');

            expect(cache.getCurrent('k', false)).toEqual({ b: 2 });
        });

        test('a delta emitted one microtask after the snapshot, still before the store, is not lost', async () => {
            const subscribe = vi.fn((_key: string, e: (v: Record<string, number>) => void) => {
                e({ a: 1, b: 1 });
                void Promise.resolve().then(() => e({ b: 2 }));
                return () => { /* no-op */ };
            });
            const merge = vi.fn((cur: Record<string, number>, inc: Record<string, number>) => ({ ...cur, ...inc }));
            const ext = createSubscriptionExtension<Record<string, number>>(subscribe, { policy: 'forever', merge });
            const cache = new PromiseCache<Record<string, number>>(ext.fetch).extend(ext);

            await cache.get('k');

            expect(cache.getCurrent('k', false)).toEqual({ a: 1, b: 2 });
        });
    });

    describe('onStored observer sees the buffer drain in causal order', () => {
        test('updates buffered ahead of the fetch store are announced after it, in order, and the cache ends on the last one', async () => {
            let emit!: (v: string) => void;
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                emit = e;
                return () => { /* no-op */ };
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            const seen: string[] = [];
            cache.onStored.on(({ value }) => { seen.push(value); });

            const p = cache.get('k');
            emit('v0');
            emit('v1'); // buffered: not yet stored
            emit('v2'); // buffered: not yet stored
            await p;

            expect(seen).toEqual(['v0', 'v1', 'v2']);
            expect(cache.getCurrent('k', false)).toBe('v2');
        });

        test('an update emitted while the drain is scheduled but not yet run still queues behind it', async () => {
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                e('v0'); // resolves the fetch
                e('v1'); // buffered: not yet stored
                void Promise.resolve().then(() => e('v2')); // arrives after the store, while the drain of v1 is scheduled
                return () => { /* no-op */ };
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            const seen: string[] = [];
            cache.onStored.on(({ value }) => { seen.push(value); });

            await cache.get('a');

            expect(seen).toEqual(['v0', 'v1', 'v2']);
            expect(cache.getCurrent('a', false)).toBe('v2');
        });

        test('an emission from an onStored observer during the drain queues behind the remaining buffer, not ahead of it', async () => {
            let emit!: (v: string) => void;
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                emit = e;
                return () => { /* no-op */ };
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            const seen: string[] = [];
            let injected = false;
            cache.onStored.on(({ value }) => {
                seen.push(value);
                if (value === 'v1' && !injected) {
                    injected = true;
                    emit('v3'); // reacts mid-drain, causally after v2 (already buffered ahead of it)
                }
            });

            const p = cache.get('k');
            emit('v0'); // resolves the fetch
            emit('v1'); // buffered: not yet stored
            emit('v2'); // buffered: not yet stored
            await p;
            await Promise.resolve();
            await Promise.resolve();

            expect(seen).toEqual(['v0', 'v1', 'v2', 'v3']);
            expect(cache.getCurrent('k', false)).toBe('v3');
        });
    });

    describe('teardown mid-fetch settles the pending fetch (R2)', () => {
        test('sanitize() purging an expired key mid-refresh settles refresh() and drops loadingCount, ignoring the late emission', async () => {
            vi.useFakeTimers();
            try {
                let call = 0;
                const lateEmits: Array<(v: string) => void> = [];
                const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                    call++;
                    if (call === 1) {
                        e('v1');
                    } else {
                        lateEmits.push(e); // refetch: no emission yet
                    }
                    return () => { /* no-op */ };
                });
                const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
                const cache = new PromiseCache<string>(ext.fetch)
                    .useInvalidation({ expirationMs: 10 })
                    .extend(ext);

                await cache.get('a');
                await vi.advanceTimersByTimeAsync(20); // expire 'a'

                let refreshSettled = false;
                const refreshP = cache.refresh('a').then(() => { refreshSettled = true; });
                expect(cache.loadingCount).toBe(1);

                cache.sanitize(); // purges expired 'a' mid-refetch, tears down the new entry

                lateEmits[0]?.('v2'); // the source finally emits — the entry is already cancelled

                await refreshP;

                expect(cache.loadingCount).toBe(0);
                expect(refreshSettled).toBe(true);
                expect(cache.getCurrent('a', false)).toBeUndefined();
            } finally {
                vi.useRealTimers();
            }
        });

        test('delete() during the first pending fetch settles get() and drops loadingCount', async () => {
            const emits: Array<(v: string) => void> = [];
            const subscribe = vi.fn((_key: string, e: (v: string) => void) => {
                emits.push(e);
                return () => { /* no-op */ };
            });
            const ext = createSubscriptionExtension<string>(subscribe, { policy: 'forever' });
            const cache = new PromiseCache<string>(ext.fetch).extend(ext);

            let settled = false;
            const p = cache.get('a').then(() => { settled = true; });
            expect(cache.loadingCount).toBe(1);

            cache.delete('a'); // teardown before the first emission
            emits[0]?.('v1'); // ignored — the entry is already cancelled

            await p;

            expect(settled).toBe(true);
            expect(cache.loadingCount).toBe(0);
            expect(cache.getCurrent('a', false)).toBeUndefined();
        });
    });
});
