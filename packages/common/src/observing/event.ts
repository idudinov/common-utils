import type { Predicate } from '../types/index.js';
import { forEachAsync } from '../async/arrays.js';
import { catchPromise } from '../functions/safe.js';
import { Loggable } from '../logger/loggable.js';

export type EventHandler<T = any> = (data: T) => void | Promise<void>;
type Unsubscribe = () => void;

export interface IEvent<T = any> {
    on(handler: EventHandler<T>): () => void;
    off(handler: EventHandler<T>): void;
}

export class Event<T = any> extends Loggable implements IEvent<T> {
    private _handlers: EventHandler<T>[] = [];

    public get isEmpty() { return this._handlers.length === 0; }

    protected getLoggerName(name: string | undefined): string {
        return `[Event:${name || '?'}]`;
    }

    /** Clears handlers list */
    public resetHandlers = () => {
        this._handlers = [];
    };

    public on(handler: EventHandler<T>): Unsubscribe {
        this._handlers.push(handler);
        return () => {
            this.off(handler);
        };
    }

    public off(handler: EventHandler<T>): void {
        this._handlers = this._handlers.filter(h => h !== handler);
    }

    /** The zero-argument form exists only on `Event<void>`; payload-carrying events require `data`. */
    public trigger(this: Event<void>): void;
    public trigger(data: T): void;
    public trigger(data?: T) {
        if (!this._handlers.length) {
            return;
        }

        const hh = this._handlers.slice(0);
        hh.forEach(cb => {
            try {
                catchPromise(cb(data as T), err => this.logError(data, cb, err));
            } catch (err) {
                this.logError(data, cb, err);
            }
        });
    }

    /** {@link trigger} counterpart that awaits handlers and collects their errors. */
    public triggerAsync(this: Event<void>): Promise<Error[]>;
    public triggerAsync(data: T): Promise<Error[]>;
    public async triggerAsync(data?: T): Promise<Error[]> {
        if (!this._handlers.length) {
            return [];
        }

        const hh = this._handlers.slice(0);

        const errors: Error[] = [];

        await forEachAsync(hh, async (cb: EventHandler<T>, index: number) => {
            try {
                await cb(data as T);
            } catch (err) {
                this.logError(data, cb, err);
                if (err instanceof Error) {
                    errors[index] = err;
                } else if (typeof err === 'string') {
                    errors[index] = new Error(err);
                } else {
                    errors[index] = new Error(`Event handler thrown an exception: ${err as any}`);
                }
            }
        });

        return errors;
    }

    public expose(): IEvent<T> {
        return this;
    }

    private logError(data: T | null | undefined, cb: EventHandler<T>, err: unknown) {
        this.logger.error(`type:${typeof data} Handler ${cb.name || '<anonymous>'} thrown an exception: `, err);
    }
}

export function oneTimeSubscription<T>(e: IEvent<T>, filter?: Predicate<T>): Promise<T> {
    return new Promise<T>((resolve) => {
        let unsubscribe: Unsubscribe | null = null;
        unsubscribe = e.on(v => {
            if (!filter || filter(v)) {
                // the callback can be called during subscription, so unsubscribe may not be initialized yet.
                // in that case assume that unsubscribing is not needed
                unsubscribe?.();
                resolve(v);
            }
        });
    });
}
