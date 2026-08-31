
import { setTimeoutAsync } from '../../async/timeout.js';
import { LazyPromise } from '../promise.js';
import { viewLoadingState } from '../loadingState.js';

describe('viewLoadingState', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('reports isLoading per view while the source and sibling views report their own, sharing one load', async () => {
        let counter = 0;
        const factory = vi.fn(() => setTimeoutAsync(10).then(() => ++counter));
        const source = new LazyPromise(factory);

        const loudView = viewLoadingState(source, { loading: false });
        const quietView = viewLoadingState(source, { loading: true });

        expect(source.isLoading).toBeNull();
        expect(loudView.isLoading).toBeNull();
        expect(quietView.isLoading).toBeNull();

        const p = source.promise;
        expect(source.isLoading).toBeTrue(); // default
        expect(loudView.isLoading).toBeFalse(); // overridden
        expect(quietView.isLoading).toBeTrue(); // overridden to same value as default, still true

        await vi.advanceTimersByTimeAsync(10);
        await p;

        expect(factory).toHaveBeenCalledTimes(1); // one shared load, not one per view
        expect(source.isLoading).toBeFalse();
        expect(loudView.isLoading).toBeFalse();
        expect(quietView.isLoading).toBeFalse();
    });

    test('unnamed keys fall through to the source report, not to library defaults', async () => {
        let counter = 0;
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => ++counter))
            .withLoadingState({ refreshing: true }); // instance-level override

        const view = viewLoadingState(source, {}); // view names nothing

        const p1 = source.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;

        const refreshPromise = source.refresh();
        expect(source.isLoading).toBeTrue(); // instance strategy
        expect(view.isLoading).toBeTrue(); // falls through to source, not to the false default

        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;
    });

    test('pendingState forwards the source', async () => {
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const view = viewLoadingState(source, { loading: false });

        expect(view.pendingState).toBeNull();

        const p = source.promise;
        expect(view.pendingState).toBe('loading');
        expect(source.pendingState).toBe('loading');

        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(view.pendingState).toBeNull();
    });

    test('hasValue/value/error are identical across source and views', async () => {
        let shouldFail = false;
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => {
            if (shouldFail) {
                throw new Error('fail');
            }
            return 'value';
        }));
        const view = viewLoadingState(source, { refreshing: true });

        const p1 = source.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;

        expect(view.hasValue).toBe(source.hasValue);
        expect(view.value).toBe(source.value);
        expect(view.error).toBe(source.error);

        shouldFail = true;
        const refreshPromise = source.refresh();
        await vi.advanceTimersByTimeAsync(10);
        await refreshPromise;

        expect(view.hasValue).toBe(source.hasValue);
        expect(view.value).toBe(source.value);
        expect(view.error).toBe(source.error);
    });

    test('refresh() through a view is a shared load — factory called once, source sees it too', async () => {
        let counter = 0;
        const factory = vi.fn(() => setTimeoutAsync(10).then(() => ++counter));
        const source = new LazyPromise(factory);
        const view = viewLoadingState(source, { refreshing: true });

        const p1 = source.promise;
        await vi.advanceTimersByTimeAsync(10);
        await p1;
        factory.mockClear();

        const refreshPromise = view.refresh();
        expect(source.isLoading).toBeFalse(); // default strategy hides the refresh on the source
        expect(view.isLoading).toBeTrue(); // view strategy reports it

        await vi.advanceTimersByTimeAsync(10);
        const result = await refreshPromise;

        expect(factory).toHaveBeenCalledTimes(1);
        expect(result).toBe(2);
        expect(source.value).toBe(2);
        expect(view.value).toBe(2);
    });

    test('viewLoadingState composes over an already-forked view (fork-then-fork)', async () => {
        const source = new LazyPromise(() => setTimeoutAsync(10).then(() => 1));
        const innerView = viewLoadingState(source, { loading: false });
        const outerView = viewLoadingState(innerView, { loading: true });

        const p = source.promise;
        expect(innerView.isLoading).toBeFalse();
        expect(outerView.isLoading).toBeTrue();

        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(outerView.isLoading).toBeFalse();
    });
});
