import { LazyPromise } from '../promise.js';

/** Disposable test value: tracks whether `dispose()` was called. */
const makeValue = (id: number) => {
    let disposed = false;
    return {
        id,
        get disposed() { return disposed; },
        dispose() { disposed = true; },
    };
};

type Value = ReturnType<typeof makeValue>;

describe('LazyPromise reset() cleanup identity guard', () => {

    test('reset() mid-flight, then a new load resolves, then the abandoned factory settles — the new value is not disposed', async () => {
        let releaseFirst: (() => void) | null = null;
        let call = 0;
        const values: Value[] = [];

        const lazy = new LazyPromise<Value>(async () => {
            const my = ++call;
            if (my === 1) {
                await new Promise<void>(r => { releaseFirst = r; });
            }
            const v = makeValue(my);
            values.push(v);
            return v;
        });

        void lazy.value; // load #1 starts, hangs on releaseFirst
        await Promise.resolve();

        lazy.reset(); // schedules cleanup on the abandoned chain (load #1)

        void lazy.value; // load #2 starts and resolves immediately
        await Promise.resolve();
        await Promise.resolve();

        expect(lazy.currentValue?.id).toBe(2);
        const liveValue = lazy.currentValue!;
        expect(liveValue.disposed).toBe(false);

        releaseFirst!(); // the abandoned load #1 finally settles — its abandoned branch resolves to the live value
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // the value the consumer currently holds must survive
        expect(lazy.currentValue?.id).toBe(2);
        expect(lazy.currentValue?.disposed).toBe(false);
        expect(liveValue.disposed).toBe(false);
    });

});
