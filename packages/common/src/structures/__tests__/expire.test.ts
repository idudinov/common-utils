import { ExpireTracker } from '../expire.js';

describe('ExpireTracker', () => {

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('unstarted tracker is not expired', () => {
        const tracker = new ExpireTracker(10);
        expect(tracker.isExpired).toBeFalse();
        expect(tracker.remainingMs).toBe(Infinity);
    });

    test('expire() forces expiry on an unstarted tracker', () => {
        const tracker = new ExpireTracker(10);
        tracker.expire();
        expect(tracker.isExpired).toBeTrue();
        expect(tracker.remainingMs).toBe(0);
    });

    test('restart() after expire() works as before', async () => {
        const tracker = new ExpireTracker(10);
        tracker.expire();
        expect(tracker.isExpired).toBeTrue();

        tracker.restart();
        expect(tracker.isExpired).toBeFalse();
        expect(tracker.remainingMs).toBeLessThanOrEqual(10);

        await vi.advanceTimersByTimeAsync(11);
        expect(tracker.isExpired).toBeTrue();
    });

    test('restart() and expire() return the instance for chaining', () => {
        const tracker = new ExpireTracker(10);
        expect(tracker.expire()).toBe(tracker);
        expect(tracker.restart()).toBe(tracker);
    });

    test('neverExpiring() returns a tracker that never expires until expire() or restart() runs', () => {
        const tracker = ExpireTracker.neverExpiring();
        expect(tracker.isExpired).toBeFalse();
        expect(tracker.remainingMs).toBe(Infinity);

        tracker.expire();
        expect(tracker.isExpired).toBeTrue();
    });
});
