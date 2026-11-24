import { Loggable } from '../logger/loggable.js';
import type { ILogger } from '../logger/types.js';
import { plainStorageProvider } from '../models/plainStorageProvider.js';
import type { IValueModel, ValueStorageProvider } from '../models/types.js';
import { Event, type IEvent } from '../observing/event.js';

export type LocaleContextOptions = {
    /** Supplies the boxes of the context and of the groups bound to it; plain boxes when omitted. */
    storage?: ValueStorageProvider;
    /** The current language, or `null` for none; unchanged when omitted. */
    locale?: string | null;
};

/** The current language shared by every group of localized strings bound to the context. */
export class LocaleContext extends Loggable implements ValueStorageProvider {
    /** The context that groups bind to by default, with no language until one is set. */
    public static readonly Shared = new LocaleContext();

    private _storage: ValueStorageProvider = plainStorageProvider;
    private _initialLocale: string | null = null;

    private _locale: IValueModel<string | null> | null = null;
    private _hasBoxes = false;

    private readonly _localeChanged = new Event<string | null>();

    constructor(options?: LocaleContextOptions) {
        super();

        if (options) {
            this.configure(options);
        }
    }

    public override get logger(): ILogger {
        return super.logger;
    }

    /** The current language, or `null` for none. */
    public get Locale(): string | null {
        return this.localeBox.value;
    }

    /** Fires after the current language changes, with the new language. */
    public get localeChanged(): IEvent<string | null> {
        return this._localeChanged.expose();
    }

    private get localeBox(): IValueModel<string | null> {
        return this._locale ??= this.createValue(this._initialLocale);
    }

    /** Switches the current language synchronously. */
    public useLocale(locale: string | null): void {
        const box = this.localeBox;
        if (box.value === locale) {
            return;
        }

        box.value = locale;
        this._localeChanged.trigger(locale);
    }

    /**
     * Applies options; omitted ones stay as they are.
     *
     * Throws:
     * - once a box exists: after a read of {@link Locale}, a {@link useLocale} call, or a group's first use, so a late storage provider is never silently ignored
     */
    public configure(options: LocaleContextOptions): void {
        if (this._hasBoxes) {
            throw new Error('LocaleContext: cannot be configured after a box has been created');
        }

        if (options.storage) {
            this._storage = options.storage;
        }

        if (options.locale !== undefined && options.locale !== this._initialLocale) {
            this._initialLocale = options.locale;
            this._localeChanged.trigger(options.locale);
        }
    }

    /** Creates a box from the context's storage provider; {@link configure} throws afterwards. */
    public createValue<V>(initial: V): IValueModel<V> {
        this._hasBoxes = true;
        return this._storage.createValue(initial);
    }

    public transaction<R>(fn: () => R): R {
        return this._storage.transaction ? this._storage.transaction(fn) : fn();
    }
}
