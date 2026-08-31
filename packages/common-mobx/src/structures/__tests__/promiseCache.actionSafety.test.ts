import { Disposer } from '@zajno/common/functions/disposer';
import { autorun, configure, reaction } from 'mobx';
import { PromiseCacheObservable } from '../promiseCache.js';

// --- Strict mode: every mutation, observed or not, must run inside an action ---
describe('PromiseCache observable — enforceActions: always', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        configure({ enforceActions: 'always' });
    });

    afterEach(() => {
        vi.useRealTimers();
        configure({ enforceActions: 'never' });
    });

    it('fetch round-trip, set(), invalidate(), clear(), and a useLoadingState swap warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));
        disposer.add(autorun(() => { void cache.getCurrent('a', false); }));

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);
        expect(cache.getCurrent('a', false)).toBe(1);

        cache.set('a', 2);
        expect(cache.getCurrent('a', false)).toBe(2);

        cache.invalidate('a');
        expect(cache.getCurrent('a', false)).toBeUndefined();

        cache.useLoadingState({ loading: false });

        cache.clear();

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('reaction on getIsLoading(key) fires across a fetch lifecycle', async () => {
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const handler = vi.fn();
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getIsLoading('a'),
                v => handler(v),
                { fireImmediately: true },
            ),
        );

        expect(handler).toHaveBeenCalledWith(null);

        const p = cache.get('a');
        expect(handler).toHaveBeenCalledWith(true);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(handler).toHaveBeenCalledWith(false);

        disposer.dispose();
    });

    it('reaction on getIsLoading re-fires when useLoadingState changes the strategy mid-flight', async () => {
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const handler = vi.fn();
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => cache.getIsLoading('a'),
                v => handler(v),
            ),
        );

        const p = cache.get('a');
        expect(cache.getIsLoading('a')).toBe(true);

        cache.useLoadingState({ loading: false });
        expect(cache.getIsLoading('a')).toBe(false);
        expect(handler).toHaveBeenCalledWith(false);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        disposer.dispose();
    });

    it('sanitize() and invalidate(key, \'silent\') run warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(async () => 1)
            .useInvalidation({ expirationMs: 5 });

        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));
        disposer.add(autorun(() => { void cache.getCurrent('a', false); }));

        await cache.get('a');
        await vi.advanceTimersByTimeAsync(10);

        expect(cache.sanitize()).toBe(1);

        await cache.get('b');
        cache.invalidate('b', 'silent');
        expect(cache.hasKey('b')).toBe(false);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('fetch success runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return 1;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('fetch error runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            throw new Error('fail');
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(cache.getLastError('a')).toBeInstanceOf(Error);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('refresh success runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let counter = 0;
        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return ++counter;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;

        const r = cache.refresh('a');
        await vi.advanceTimersByTimeAsync(10);
        expect(await r).toBe(2);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('superseded refresh runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let counter = 0;
        const cache = new PromiseCacheObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return ++counter;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p0 = cache.get('a');
        await vi.advanceTimersByTimeAsync(10);
        await p0;

        const r1 = cache.refresh('a');
        const r2 = cache.refresh('a'); // supersedes r1 before it settles
        await vi.advanceTimersByTimeAsync(10);
        await Promise.all([r1, r2]);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('cancelled fetch via set() mid-flight runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let resolveOriginal!: (v: number) => void;
        const cache = new PromiseCacheObservable<number>(
            () => new Promise<number>(resolve => { resolveOriginal = resolve; }),
        );
        const disposer = new Disposer();
        disposer.add(autorun(() => { void cache.getIsLoading('a'); }));

        const p = cache.get('a');
        cache.set('a', 42);
        expect(cache.getCurrent('a', false)).toBe(42);

        resolveOriginal(999); // let the superseded original fetch settle and run its cleanup transaction
        await p;

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('reaction on getHasValue(key) + getIsLoading(key) together fires exactly once per semantic operation', async () => {
        const cache = new PromiseCacheObservable<number>(
            async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 10));
                return 1;
            },
        );

        const seen: { hasValue: boolean; isLoading: boolean | null }[] = [];
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => ({ hasValue: cache.getHasValue('a'), isLoading: cache.getIsLoading('a') }),
                v => seen.push(v),
            ),
        );

        const p = cache.get('a');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toStrictEqual({ hasValue: false, isLoading: true });

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(seen).toHaveLength(2);
        expect(seen[1]).toStrictEqual({ hasValue: true, isLoading: false });

        disposer.dispose();

        // set() on a never-touched key: hasValue/isLoading both transition together in one store
        const seenB: { hasValue: boolean; isLoading: boolean | null }[] = [];
        const disposerB = new Disposer();
        disposerB.add(
            reaction(
                () => ({ hasValue: cache.getHasValue('b'), isLoading: cache.getIsLoading('b') }),
                v => seenB.push(v),
            ),
        );

        cache.set('b', 2);

        expect(seenB).toHaveLength(1);
        expect(seenB[0]).toStrictEqual({ hasValue: true, isLoading: false });

        disposerB.dispose();
    });
});
