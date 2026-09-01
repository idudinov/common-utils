
import { setTimeoutAsync } from '../../../async/timeout.js';
import { LazyPromise } from '../../../lazy/promise.js';
import { PromiseCache } from '../index.js';
import { delayedValue } from './helpers.js';

describe('PromiseCache loading state strategy', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- useLoadingState: silencing passive revalidation ---
    test('{ revalidating: false } silences isLoading during a passive re-fetch of an expired item; loadingCount still increments', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter))
            .useInvalidation({ expirationMs: 10 })
            .useLoadingState({ revalidating: false });

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(cache.getCurrent('a', false)).toBe(1);

        await vi.advanceTimersByTimeAsync(11); // expire

        const p2 = cache.get('a'); // triggers passive revalidation
        expect(cache.getCurrent('a', false)).toBe(1); // stale value stays readable
        expect(cache.getIsLoading('a')).toBe(false); // silenced — not undefined, not true
        expect(cache.loadingCount).toBe(1); // still counted globally

        await vi.advanceTimersByTimeAsync(10);
        await p2;
        expect(cache.getCurrent('a', false)).toBe(2);
        expect(cache.getIsLoading('a')).toBe(false);
        expect(cache.loadingCount).toBe(0);
    });

    // --- useLoadingState: loudening refresh() ---
    test('{ refreshing: true } reports isLoading true while a warm refresh is in flight, false after', async () => {
        let counter = 0;
        const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter))
            .useLoadingState({ refreshing: true });

        const p1 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(cache.getIsLoading('a')).toBe(false); // settled

        const refreshPromise = cache.refresh('a');
        expect(cache.getIsLoading('a')).toBe(true);

        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;
        expect(cache.getIsLoading('a')).toBe(false);
    });

    // --- refresh() classification: no value exists, regardless of a prior error ---
    test('refresh() classifies as \'loading\' when no value exists, whether or not a prior error exists', async () => {
        const failKeys = new Set<string>();
        const cache = new PromiseCache<number>(async (id) => {
            await setTimeoutAsync(10);
            if (failKeys.has(id)) throw new Error('fail');
            return 1;
        }); // default: loading → true

        // never fetched: refresh() on a key that was never touched
        const coldPromise = cache.refresh('cold');
        expect(cache.getIsLoading('cold')).toBe(true);
        expect(cache.getLazy('cold').pendingState).toBe('loading');
        await vi.advanceTimersByTimeAsync(10);
        await coldPromise;
        expect(cache.getIsLoading('cold')).toBe(false);

        // failed: get() fails first (leaves an error, no value), then refresh()
        failKeys.add('failed');
        const p1 = cache.get('failed');
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        expect(cache.getLastError('failed')).toBeInstanceOf(Error);

        const refreshPromise = cache.refresh('failed');
        expect(cache.getIsLoading('failed')).toBe(true);
        expect(cache.getLazy('failed').pendingState).toBe('loading');

        failKeys.delete('failed'); // let the refresh succeed
        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;
        expect(cache.getIsLoading('failed')).toBe(false);
        expect(cache.getLastError('failed')).toBeNull();
    });

    // --- getLazy(key, strategy): per-handle views ---
    describe('getLazy(key, strategy)', () => {

        test('reports its own isLoading while the cache-level report (and a strategy-less handle) differ, sharing one refresh', async () => {
            let counter = 0;
            const factory = vi.fn(async () => delayedValue(10, ++counter));
            const cache = new PromiseCache<number>(factory); // default strategy: refreshing → false

            const p1 = cache.get('a');
            await vi.advanceTimersByTimeAsync(10);
            await p1;

            const loudLazy = cache.getLazy('a', { refreshing: true });
            const quietLazy = cache.getLazy('a'); // no handle strategy — falls through to cache-level
            factory.mockClear();

            const refreshPromise = cache.refresh('a');
            expect(cache.getIsLoading('a')).toBe(false); // cache-level default
            expect(quietLazy.isLoading).toBe(false); // falls through to cache-level
            expect(loudLazy.isLoading).toBe(true); // handle strategy overrides
            expect(loudLazy.pendingState).toBe('refreshing'); // matches the status map kind

            await vi.advanceTimersByTimeAsync(10);
            await refreshPromise;

            expect(factory).toHaveBeenCalledTimes(1); // shared load, not one per handle
            expect(loudLazy.isLoading).toBe(false);
            expect(quietLazy.isLoading).toBe(false);
        });

        test('unnamed pending states fall through to the cache-level strategy, not to library defaults', async () => {
            const cache = new PromiseCache<number>(async () => delayedValue(10, 1))
                .useLoadingState({ loading: false }); // cache-level: initial load silenced

            const lazy = cache.getLazy('a', { refreshing: true }); // handle names only 'refreshing'

            const p = lazy.promise; // triggers 'loading', which the handle doesn't name
            expect(lazy.pendingState).toBe('loading');
            expect(lazy.isLoading).toBe(false); // falls through to the cache-level strategy

            await vi.advanceTimersByTimeAsync(10);
            expect(await p).toBe(1);
            expect(lazy.isLoading).toBe(false);
        });
    });

    // --- Strategy changes apply retroactively ---
    test('useLoadingState() called mid-flight is reflected retroactively by getIsLoading', async () => {
        const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

        const p = cache.get('a');
        expect(cache.getIsLoading('a')).toBe(true); // default: loading → true

        cache.useLoadingState({ loading: false });
        expect(cache.getIsLoading('a')).toBe(false); // retroactive — same in-flight fetch

        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);
        expect(cache.getIsLoading('a')).toBe(false); // settled
    });

    test('strategy is read live: getter-based fields re-evaluate on each getIsLoading read', async () => {
        let silent = false;
        const cache = new PromiseCache<number>(async () => delayedValue(10, 1))
            .useLoadingState({ get loading() { return silent ? false : true; } });

        const p = cache.get('a');
        expect(cache.getIsLoading('a')).toBe(true);

        silent = true;
        expect(cache.getIsLoading('a')).toBe(false); // same in-flight fetch, re-derived

        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);
        expect(cache.getIsLoading('a')).toBe(false); // settled
    });

    // --- Documented micro-deviations (deliberate, not accidental) ---
    describe('documented micro-deviations at defaults', () => {

        test('hasKey() is true while a cold refresh() is in flight', async () => {
            const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

            expect(cache.hasKey('a')).toBe(false);
            const refreshPromise = cache.refresh('a');
            expect(cache.hasKey('a')).toBe(true);

            await vi.advanceTimersByTimeAsync(10);
            await refreshPromise;
        });

        test('getIsLoading reports false (not undefined) while refresh()ing an expired cached item', async () => {
            let counter = 0;
            const cache = new PromiseCache<number>(async () => delayedValue(10, ++counter))
                .useInvalidation({ expirationMs: 10 });

            const p1 = cache.get('a');
            await vi.advanceTimersByTimeAsync(10);
            await p1;

            await vi.advanceTimersByTimeAsync(11); // expire
            expect(cache.getIsValid('a')).toBe(false);

            const refreshPromise = cache.refresh('a'); // classified 'refreshing' — a value exists, invalidation ignored
            expect(cache.getIsLoading('a')).toBe(false);

            await vi.advanceTimersByTimeAsync(10);
            await refreshPromise;
        });
    });

    // --- getIsLoading: never-started null vs in-flight/settled boolean ---
    describe('getIsLoading: never-started (null) vs in-flight/settled (boolean)', () => {

        test('a truly untouched key reports null', async () => {
            const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

            expect(cache.getIsLoading('nope')).toBeNull();
        });

        test('no strategy: a cold refresh() reports true (nothing usable to show) while in flight', async () => {
            const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

            const refreshPromise = cache.refresh('cold');
            expect(cache.getIsLoading('cold')).toBe(true);
            expect(cache.hasKey('cold')).toBe(true);
            expect(cache.getLazy('cold').isLoading).toBe(true);

            await vi.advanceTimersByTimeAsync(10);
            await refreshPromise;
        });

        test('a settled item reports false from both getIsLoading and getLazy().isLoading', async () => {
            const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

            const p = cache.get('a');
            await vi.advanceTimersByTimeAsync(10);
            await p;

            expect(cache.getIsLoading('a')).toBe(false);
            expect(cache.getLazy('a').isLoading).toBe(false);
        });
    });

    // --- pendingState tracks the in-flight kind, null once settled ---
    test('getLazy().pendingState reflects the in-flight kind and returns null once settled', async () => {
        const cache = new PromiseCache<number>(async () => delayedValue(10, 1));
        const lazy = cache.getLazy('a');

        expect(lazy.pendingState).toBeNull();
        const p = lazy.promise;
        expect(lazy.pendingState).toBe('loading');

        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(lazy.pendingState).toBeNull();
    });

    // --- set() settles the key rather than clearing its status ---
    describe('set() reports false (settled), not null', () => {

        test('set() on a never-fetched key settles it: getIsLoading/isLoading false, pendingState null', () => {
            const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

            cache.set('a', 42);

            expect(cache.getIsLoading('a')).toBe(false);
            expect(cache.getLazy('a').isLoading).toBe(false);
            expect(cache.getLazy('a').pendingState).toBeNull();
        });

        test('parity: LazyPromise.setInstance() also reports isLoading false', () => {
            const lazy = new LazyPromise(async () => delayedValue(10, 1));

            lazy.setInstance(42);

            expect(lazy.isLoading).toBe(false);
            expect(lazy.pendingState).toBeNull();
        });

        test('set() then delete() goes back to null', () => {
            const cache = new PromiseCache<number>(async () => delayedValue(10, 1));

            cache.set('a', 42);
            expect(cache.getIsLoading('a')).toBe(false);

            cache.delete('a');
            expect(cache.getIsLoading('a')).toBeNull();
        });
    });
});
