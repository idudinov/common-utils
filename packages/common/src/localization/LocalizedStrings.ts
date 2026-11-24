import { createLazy } from '../lazy/light.js';
import { LazyPromise } from '../lazy/promise.js';
import { resolvedLazyPromise } from '../lazy/resolved.js';
import type { ILazy, ILazyPromise } from '../lazy/types.js';
import { Loggable } from '../logger/loggable.js';
import type { IValueModel } from '../models/types.js';
import { isPlainObject } from '../types/isPlainObject.js';
import type { AnyObject } from '../types/misc.js';
import type { ILocalization, StringsLoader, StringsPatch } from './abstractions.js';
import { LocaleContext } from './LocaleContext.js';
import { resolveLocale } from './resolveLocale.js';

export type LocalizedStringsOptions<TStrings extends AnyObject, TOthers extends string> = {
    /** Other languages, each with the full shape of the default. */
    others?: { [K in TOthers]: StringsLoader<NoInfer<TStrings>> };
    /** The context whose language the group follows; {@link LocaleContext.Shared} when omitted. */
    context?: LocaleContext;
};

/**
 * A group of localized strings in a default language and optional other languages, following a {@link LocaleContext}.
 * A failed language load is logged to the group's own logger, or to the context's logger when the group has none.
 */
export class LocalizedStrings<TDefault extends string, TStrings extends AnyObject, TOthers extends string = never> extends Loggable implements ILocalization<TStrings> {
    private readonly _context: LocaleContext;

    private readonly _locales: readonly (TDefault | TOthers)[];

    private readonly _languages: Map<TDefault | TOthers, ILazy<ILazyPromise<TStrings>>>;

    private readonly _patches: { [K in TDefault | TOthers]?: StringsPatch<TStrings> }[] = [];
    private readonly _patched = new Map<TDefault | TOthers, TStrings>();

    private _revision: IValueModel<number> | null = null;
    private _resolved: { requested: string | null; locale: TDefault | TOthers } | null = null;

    /**
     * Creates a group from a default language and optional other languages, each with the full shape of the default.
     *
     * Other languages:
     * - each is its strings, or a loader that returns them
     * - a loader runs when the group first needs its language, or on {@link preload}
     *
     * Extra keys:
     * - TypeScript checks them only in an inline language object
     * - a language declared as a separate constant needs `satisfies` against the default's type
     *
     * @param options - The other languages and the context the group follows, see {@link LocalizedStringsOptions}.
     */
    constructor(
        private readonly _defaultLocale: TDefault,
        defaultStrings: TStrings,
        options?: LocalizedStringsOptions<TStrings, TOthers>,
    ) {
        super();

        this._context = options?.context ?? LocaleContext.Shared;
        const sources = Object.entries(options?.others ?? {}) as [TOthers, StringsLoader<TStrings>][];
        const languages = [...sources, [_defaultLocale, defaultStrings]] as [TDefault | TOthers, StringsLoader<TStrings>][];
        // A LazyPromise creates its boxes on construction, so each language is created on first need.
        this._languages = new Map(languages.map(([locale, source]) => [locale, createLazy(() => this.createLanguage(source))]));
        this._locales = [...new Set<TDefault | TOthers>([_defaultLocale, ...sources.map(([locale]) => locale)])];
    }

    /** The strings for the shown language with its patches applied, as one object that stays the same until the language or a patch changes. */
    public get Current(): Readonly<TStrings> {
        // Read on every call, so a patch is visible to whoever tracks box reads.
        void this.revisionBox.value;
        return this.stringsFor(this.Locale);
    }

    /**
     * The language {@link Current} shows, picked by {@link selectShownLocale} from the language that {@link resolveLocale} gives for the context's language.
     * Starts the load of that language when it is not loaded and none has started.
     */
    public get Locale(): TDefault | TOthers {
        const resolved = this.resolve(this._context.Locale);
        const language = this.languageFor(resolved);
        if (language.isLoading === null) {
            void this.startLoad(resolved, language);
        }

        return this.selectShownLocale(resolved);
    }

    private get revisionBox(): IValueModel<number> {
        return this._revision ??= this._context.createValue(0);
    }

    /**
     * Overrides strings per language, merged over that language's data.
     *
     * Merging:
     * - patches apply in call order, a later one wins
     * - plain objects merge recursively
     * - strings, functions and arrays replace the value whole
     * - a patch on one language leaves the others as they are
     *
     * @returns a function that removes this patch
     */
    public patch(patches: { [K in TDefault | TOthers]?: StringsPatch<TStrings> }): () => void {
        const entry = { ...patches };
        this._patches.push(entry);
        this.invalidate(entry);

        return () => {
            const index = this._patches.indexOf(entry);
            if (index < 0) {
                return;
            }

            this._patches.splice(index, 1);
            this.invalidate(entry);
        };
    }

    /**
     * Loads the language that `locale` resolves to, as the context's language would be resolved.
     *
     * Loading:
     * - resolves at once for a language that is inline or already loaded
     * - joins the load of the language when one is running
     * - runs the loader again when an earlier load failed
     * - never changes the language the group shows
     *
     * Rejects:
     * - with an `Error` naming the language, and the loader's error as `cause`
     *
     * @param locale - A language as passed to {@link LocaleContext.useLocale}.
     */
    public async preload(locale: string): Promise<void> {
        const resolved = resolveLocale(locale, this._locales, this._defaultLocale);
        const language = this.languageFor(resolved);
        if (language.hasValue) {
            return;
        }

        await this.startLoad(resolved, language);
        if (!language.hasValue) {
            throw createLoadError(resolved, language.error);
        }
    }

    /**
     * Picks the language that {@link Locale} and {@link Current} show, given `resolved`, the language the context's language resolves to.
     * The result must be a language for which {@link isLoaded} is true.
     *
     * By default:
     * - `resolved` once it is loaded
     * - the default language until then
     */
    protected selectShownLocale(resolved: TDefault | TOthers): TDefault | TOthers {
        return this.isLoaded(resolved) ? resolved : this._defaultLocale;
    }

    /** Whether the strings of `locale` are available to read. */
    protected isLoaded(locale: TDefault | TOthers): boolean {
        return this.languageFor(locale).hasValue;
    }

    private createLanguage(source: StringsLoader<TStrings>): ILazyPromise<TStrings> {
        return typeof source === 'function'
            ? new LazyPromise(() => loadStrings(source), undefined, { storage: this._context })
            : resolvedLazyPromise(source);
    }

    private invalidate(entry: object): void {
        for (const locale of Object.keys(entry) as (TDefault | TOthers)[]) {
            this._patched.delete(locale);
        }

        if (this._revision) {
            this._revision.value += 1;
        }
    }

    private languageFor(locale: TDefault | TOthers): ILazyPromise<TStrings> {
        return this._languages.get(locale)!.value;
    }

    private resolve(requested: string | null): TDefault | TOthers {
        if (this._resolved === null || this._resolved.requested !== requested) {
            this._resolved = { requested, locale: resolveLocale(requested, this._locales, this._defaultLocale) };
        }

        return this._resolved.locale;
    }

    private startLoad(locale: TDefault | TOthers, language: ILazyPromise<TStrings>): Promise<unknown> {
        const state = language.isLoading;
        if (state === true) {
            return language.promise;
        }

        return (state === null ? language.promise : language.refresh()).then(() => {
            if (!language.hasValue) {
                const logger = this.hasLogger ? this.logger : this._context.logger;
                logger.error(createLoadError(locale, language.error));
            }
        });
    }

    private stringsFor(locale: TDefault | TOthers): TStrings {
        let strings = this._patched.get(locale);
        if (strings === undefined) {
            strings = this.languageFor(locale).currentValue!;
            for (const entry of this._patches) {
                const patch = entry[locale];
                if (patch !== undefined) {
                    strings = mergeStrings(strings, patch);
                }
            }

            this._patched.set(locale, strings);
        }

        return strings;
    }
}

function mergeStrings<T extends AnyObject>(target: T, patch: StringsPatch<T>): T {
    const result: AnyObject = { ...target };

    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
            continue;
        }

        result[key] = isPlainObject(result[key]) && isPlainObject(value)
            ? mergeStrings(result[key], value)
            : value;
    }

    return result as T;
}

async function loadStrings<TStrings extends AnyObject>(loader: () => Promise<TStrings>): Promise<TStrings> {
    const strings = await loader();
    if (!isPlainObject(strings)) {
        throw new Error('LocalizedStrings: A loader must resolve to a plain object of strings');
    }

    return strings;
}

function createLoadError(locale: string, cause: unknown): Error {
    return new Error(`LocalizedStrings: Failed to load strings for locale "${locale}"`, { cause });
}
