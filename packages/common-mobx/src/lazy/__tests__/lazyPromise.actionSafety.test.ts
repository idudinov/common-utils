import { Disposer } from '@zajno/common/functions/disposer';
import { autorun, configure, reaction } from 'mobx';
import { LazyPromiseObservable } from '../observable.js';

// --- Strict mode: every mutation, observed or not, must run inside an action ---
describe('LazyPromiseObservable — enforceActions: always', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        configure({ enforceActions: 'always' });
    });

    afterEach(() => {
        vi.useRealTimers();
        configure({ enforceActions: 'never' });
    });

    it('fetch round-trip, setInstance(), reset(), and a withLoadingState swap warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const lazy = new LazyPromiseObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return 1;
        });

        const disposer = new Disposer();
        disposer.add(autorun(() => { void lazy.isLoading; }));
        disposer.add(autorun(() => { void lazy.currentValue; }));

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe(1);
        expect(lazy.currentValue).toBe(1);

        lazy.setInstance(2);
        expect(lazy.currentValue).toBe(2);

        lazy.reset();
        expect(lazy.currentValue).toBeUndefined();

        lazy.withLoadingState({ loading: false });

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('reaction on isLoading fires across a fetch lifecycle', async () => {
        const lazy = new LazyPromiseObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return 1;
        });

        const handler = vi.fn();
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => lazy.isLoading,
                v => handler(v),
                { fireImmediately: true },
            ),
        );

        expect(handler).toHaveBeenCalledWith(null);

        const p = lazy.promise;
        expect(handler).toHaveBeenCalledWith(true);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(handler).toHaveBeenCalledWith(false);

        disposer.dispose();
    });

    it('reaction on isLoading re-fires when withLoadingState changes the strategy mid-flight', async () => {
        const lazy = new LazyPromiseObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return 1;
        });

        const handler = vi.fn();
        const disposer = new Disposer();
        disposer.add(
            reaction(
                () => lazy.isLoading,
                v => handler(v),
            ),
        );

        const p = lazy.promise;
        expect(lazy.isLoading).toBe(true);

        lazy.withLoadingState({ loading: false });
        expect(lazy.isLoading).toBe(false);
        expect(handler).toHaveBeenCalledWith(false);

        await vi.advanceTimersByTimeAsync(10);
        await p;

        disposer.dispose();
    });

    it('reset() mid-flight (including a late rejection of the abandoned factory) runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let rejectFn!: (err: Error) => void;
        const lazy = new LazyPromiseObservable<string>(
            () => new Promise<string>((_resolve, reject) => { rejectFn = reject; }),
        );
        const disposer = new Disposer();
        disposer.add(autorun(() => { void lazy.isLoading; }));

        const p = lazy.promise;
        lazy.reset();

        rejectFn(new Error('late rejection'));
        await p.catch(() => { /* swallow */ });
        await vi.advanceTimersByTimeAsync(0);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('fetch error runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const lazy = new LazyPromiseObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            throw new Error('fail');
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void lazy.isLoading; }));
        disposer.add(autorun(() => { void lazy.error; }));

        const p = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(lazy.error).toBeInstanceOf(Error);

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
        const lazy = new LazyPromiseObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return ++counter;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void lazy.isLoading; }));

        const p0 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p0;

        const r = lazy.refresh();
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
        const lazy = new LazyPromiseObservable<number>(async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            return ++counter;
        });
        const disposer = new Disposer();
        disposer.add(autorun(() => { void lazy.isLoading; }));

        const p0 = lazy.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p0;

        const r1 = lazy.refresh();
        const r2 = lazy.refresh(); // supersedes r1 before it settles
        await vi.advanceTimersByTimeAsync(10);
        await Promise.all([r1, r2]);

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('setInstance() mid-flight cancellation runs warn/error-free', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        let resolveOriginal!: (v: number) => void;
        const lazy = new LazyPromiseObservable<number>(
            () => new Promise<number>(resolve => { resolveOriginal = resolve; }),
        );
        const disposer = new Disposer();
        disposer.add(autorun(() => { void lazy.isLoading; }));

        const p = lazy.promise;
        lazy.setInstance(42);
        expect(lazy.currentValue).toBe(42);

        resolveOriginal(999); // let the superseded original factory settle and run its cleanup transaction
        await p;

        disposer.dispose();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
