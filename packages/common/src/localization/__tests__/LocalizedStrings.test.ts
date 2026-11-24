import type { AnyObject } from '../../types/misc.js';
import { LocaleContext } from '../LocaleContext.js';
import { LocalizedStrings } from '../LocalizedStrings.js';
import { createRecordingStorage } from './recordingStorage.js';

const createEn = () => ({
    buttons: { save: 'Save', cancel: 'Cancel' },
    rows: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    count: (n: number) => `${n} items`,
});

type Strings = ReturnType<typeof createEn>;

const createEs = (): Strings => ({
    buttons: { save: 'Guardar', cancel: 'Cancelar' },
    rows: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    count: (n: number) => `${n} elementos`,
});

const createFr = (): Strings => ({
    buttons: { save: 'Enregistrer', cancel: 'Annuler' },
    rows: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    count: (n: number) => `${n} elements`,
});

/** A loader whose every call waits on its own deferred promise. */
const createLoader = () => {
    const calls: PromiseWithResolvers<Strings>[] = [];
    const loader = vi.fn(() => {
        const call = Promise.withResolvers<Strings>();
        calls.push(call);
        return call.promise;
    });

    return { loader, calls };
};

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Keeps showing the last loaded language while the language the context resolves to loads. */
class KeepLoaded<TDefault extends string, TStrings extends AnyObject, TOthers extends string = never> extends LocalizedStrings<TDefault, TStrings, TOthers> {
    private _last: TDefault | TOthers | null = null;

    protected override selectShownLocale(resolved: TDefault | TOthers): TDefault | TOthers {
        if (this.isLoaded(resolved)) {
            this._last = resolved;
        }

        return this._last ?? super.selectShownLocale(resolved);
    }
}

describe('LocalizedStrings', () => {

    let en: Strings;
    let es: Strings;

    beforeEach(() => {
        en = createEn();
        es = createEs();
    });

    const createGroup = (context = new LocaleContext()) => new LocalizedStrings('en', en, { others: { es }, context });

    describe('language', () => {

        afterEach(() => {
            LocaleContext.Shared.useLocale(null);
        });

        it('shows the default language while the context has none', () => {
            const group = createGroup();

            expect(group.Current).toBe(en);
            expect(group.Locale).toBe('en');
        });

        it('follows the shared context unless given another', () => {
            const shared = new LocalizedStrings('en', en, { others: { es } });
            const own = new LocalizedStrings('en', en, { others: { es }, context: new LocaleContext() });

            LocaleContext.Shared.useLocale('es');

            expect(shared.Current).toBe(es);
            expect(shared.Locale).toBe('es');
            expect(own.Current).toBe(en);
            expect(own.Locale).toBe('en');
        });

        it('resolves a regional language to its base language, and an unknown one to the default', () => {
            const context = new LocaleContext();
            const group = createGroup(context);

            context.useLocale('es-MX');
            expect(group.Locale).toBe('es');
            expect(group.Current).toBe(es);

            context.useLocale('fr');
            expect(group.Locale).toBe('en');
            expect(group.Current).toBe(en);
        });

        it('lets groups with different languages follow one context', () => {
            const context = new LocaleContext();
            const withEs = createGroup(context);
            const onlyEn = new LocalizedStrings('en', createEn(), { context });
            const onlyEs = new LocalizedStrings('es', es, { context });

            context.useLocale('es');
            expect(withEs.Locale).toBe('es');
            expect(onlyEn.Locale).toBe('en');
            expect(onlyEs.Locale).toBe('es');

            context.useLocale('en');
            expect(withEs.Locale).toBe('en');
            expect(onlyEs.Locale).toBe('es');
        });

        it('keeps the same object while the resolved language stays', () => {
            const context = new LocaleContext();
            const group = createGroup(context);

            context.useLocale('es');
            const first = group.Current;

            context.useLocale('es-MX');
            expect(group.Current).toBe(first);
        });
    });

    describe('patch', () => {

        it('overrides only the patched strings of its language', () => {
            const context = new LocaleContext();
            const group = createGroup(context);

            group.patch({ en: { buttons: { cancel: 'Dismiss' } } });

            expect(group.Current.buttons.cancel).toBe('Dismiss');
            expect(group.Current.buttons.save).toBe(en.buttons.save);
            expect(group.Current.rows).toBe(en.rows);

            context.useLocale('es');
            expect(group.Current).toBe(es);
        });

        it('applies in call order, and a later patch wins', () => {
            const group = createGroup();

            group.patch({ en: { buttons: { save: 'Store', cancel: 'Dismiss' } } });
            group.patch({ en: { buttons: { save: 'Keep' } } });

            expect(group.Current.buttons.save).toBe('Keep');
            expect(group.Current.buttons.cancel).toBe('Dismiss');
        });

        it('patches several languages in one call', () => {
            const context = new LocaleContext();
            const group = createGroup(context);

            group.patch({ en: { buttons: { save: 'Keep' } }, es: { buttons: { save: 'Conservar' } } });

            expect(group.Current.buttons.save).toBe('Keep');
            context.useLocale('es');
            expect(group.Current.buttons.save).toBe('Conservar');
        });

        it('replaces functions and arrays whole', () => {
            const group = createGroup();
            const count = (n: number) => `${n} pieces`;

            group.patch({ en: { count, rows: [{ id: 'z', label: 'Z' }] } });

            expect(group.Current.count(2)).toBe(count(2));
            expect(group.Current.rows).toHaveLength(1);
            expect(group.Current.rows[0].id).toBe('z');
        });

        it('ignores undefined values', () => {
            const group = createGroup();

            group.patch({ en: { buttons: { save: undefined, cancel: 'Dismiss' } } });

            expect(group.Current.buttons.save).toBe(en.buttons.save);
            expect(group.Current.buttons.cancel).toBe('Dismiss');
        });

        it('removes only its own patch', () => {
            const group = createGroup();

            const removeFirst = group.patch({ en: { buttons: { save: 'Store' } } });
            group.patch({ en: { buttons: { cancel: 'Dismiss' } } });

            removeFirst();

            expect(group.Current.buttons.save).toBe(en.buttons.save);
            expect(group.Current.buttons.cancel).toBe('Dismiss');
        });

        it('removing twice does nothing the second time', () => {
            const group = createGroup();

            group.patch({ en: { buttons: { cancel: 'Dismiss' } } });
            const removeSecond = group.patch({ en: { buttons: { save: 'Store' } } });

            removeSecond();
            removeSecond();

            expect(group.Current.buttons.cancel).toBe('Dismiss');
            expect(group.Current.buttons.save).toBe(en.buttons.save);
        });

        it('returns the language data itself once every patch is removed', () => {
            const group = createGroup();

            const remove = group.patch({ en: { buttons: { cancel: 'Dismiss' } } });
            expect(group.Current).not.toBe(en);

            remove();
            expect(group.Current).toBe(en);
        });

        it('never changes the language data or the patch', () => {
            const group = createGroup();
            const patch = { en: { buttons: { cancel: 'Dismiss' } } };

            group.patch(patch);
            const { buttons } = group.Current;

            expect(en.buttons.cancel).toBe('Cancel');
            expect(buttons).not.toBe(en.buttons);
            expect(patch).toEqual({ en: { buttons: { cancel: 'Dismiss' } } });
        });
    });

    describe('identity', () => {

        it('keeps the same object while nothing changes', () => {
            const group = createGroup();

            group.patch({ en: { buttons: { cancel: 'Dismiss' } } });

            expect(group.Current).toBe(group.Current);
        });

        it('returns a new object after a patch or its removal', () => {
            const group = createGroup();

            const before = group.Current;
            const remove = group.patch({ en: { buttons: { cancel: 'Dismiss' } } });
            const patched = group.Current;
            remove();

            expect(patched).not.toBe(before);
            expect(group.Current).not.toBe(patched);
        });

        it('keeps another language object when a patch targets one language', () => {
            const context = new LocaleContext();
            const group = createGroup(context);
            context.useLocale('es');
            group.patch({ es: { buttons: { cancel: 'Descartar' } } });
            const before = group.Current;

            group.patch({ en: { buttons: { cancel: 'Dismiss' } } });

            expect(group.Current).toBe(before);
        });
    });

    describe('storage', () => {

        const setup = () => {
            const recording = createRecordingStorage();
            const context = new LocaleContext({ storage: recording.storage });
            return { ...recording, context, group: createGroup(context) };
        };

        it('reads every box on each read, also when the cached object is returned', () => {
            const { group, boxes } = setup();

            const first = group.Current;
            expect(boxes.length).toBeGreaterThan(0);

            const reads = boxes.map(box => box.reads);
            expect(group.Current).toBe(first);

            boxes.forEach((box, i) => expect(box.reads).toBeGreaterThan(reads[i]));
        });

        it('reads the context box when only the language is asked for', () => {
            const { group, totalReads } = setup();

            const before = totalReads();
            void group.Locale;

            expect(totalReads()).toBeGreaterThan(before);
        });

        it('writes a box on a patch and on its removal', () => {
            const { group, totalWrites } = setup();
            void group.Current;

            const beforePatch = totalWrites();
            const remove = group.patch({ en: { buttons: { cancel: 'Dismiss' } } });
            const afterPatch = totalWrites();
            remove();

            expect(afterPatch).toBeGreaterThan(beforePatch);
            expect(totalWrites()).toBeGreaterThan(afterPatch);
        });

        it('creates no box before the first read, so the context can still be configured', () => {
            const recording = createRecordingStorage();
            const context = new LocaleContext();
            const group = createGroup(context);
            group.patch({ en: { buttons: { cancel: 'Dismiss' } } });

            expect(() => context.configure({ storage: recording.storage })).not.toThrow();

            expect(group.Current.buttons.cancel).toBe('Dismiss');
            expect(recording.boxes.length).toBeGreaterThan(0);
        });

        it('blocks configure once the group has been read', () => {
            const context = new LocaleContext();
            void createGroup(context).Current;

            expect(() => context.configure({ locale: 'es' })).toThrow();
        });
    });

    describe('lazy languages', () => {

        const setup = (context = new LocaleContext()) => {
            const { loader, calls } = createLoader();
            const group = new LocalizedStrings('en', en, { others: { es: loader }, context });
            return { context, group, loader, calls };
        };

        it('calls no loader at construction, nor by a context switch alone, nor while the group resolves to another language', () => {
            const { context, group, loader } = setup();

            expect(loader).not.toHaveBeenCalled();

            context.useLocale('es');
            expect(loader).not.toHaveBeenCalled();

            context.useLocale('fr');
            expect(group.Locale).toBe('en');
            expect(group.Current).toBe(en);

            context.useLocale('en-US');
            expect(group.Locale).toBe('en');
            expect(loader).not.toHaveBeenCalled();
        });

        it('shows the default until the loader resolves, then the loaded language on the next read', async () => {
            const { context, group, loader, calls } = setup();

            context.useLocale('es');
            expect(group.Locale).toBe('en');
            expect(group.Current).toBe(en);
            expect(loader).toHaveBeenCalledTimes(1);

            calls[0].resolve(es);
            await flush();

            expect(group.Locale).toBe('es');
            expect(group.Current).toBe(es);
        });

        it('starts a load on a read of Current, and on a read of Locale', () => {
            const byCurrent = setup();
            const byLocale = setup();
            byCurrent.context.useLocale('es');
            byLocale.context.useLocale('es');

            void byCurrent.group.Current;
            void byLocale.group.Locale;

            expect(byCurrent.loader).toHaveBeenCalledTimes(1);
            expect(byLocale.loader).toHaveBeenCalledTimes(1);
        });

        it('shares one loader call between triggers of one language', async () => {
            const { context, group, loader, calls } = setup();

            context.useLocale('es');
            void group.Current;
            void group.Locale;
            const first = group.preload('es');
            const second = group.preload('es-MX');
            expect(loader).toHaveBeenCalledTimes(1);

            calls[0].resolve(es);
            await Promise.all([first, second]);

            expect(group.Current).toBe(es);
            expect(loader).toHaveBeenCalledTimes(1);
        });

        it('applies a patch made before its language loads', async () => {
            const { context, group, calls } = setup();

            group.patch({ es: { buttons: { cancel: 'Descartar' } } });
            context.useLocale('es');
            expect(group.Current).toBe(en);

            calls[0].resolve(es);
            await flush();

            expect(group.Current.buttons.cancel).toBe('Descartar');
            expect(group.Current.buttons.save).toBe(es.buttons.save);
        });

        it('lets a subclass keep showing the last loaded language while the next one loads', async () => {
            const context = new LocaleContext();
            const loadEs = createLoader();
            const loadFr = createLoader();
            const fr = createFr();
            const group = new KeepLoaded('en', en, { others: { es: loadEs.loader, fr: loadFr.loader }, context });

            context.useLocale('es');
            expect(group.Locale).toBe('en');

            loadEs.calls[0].resolve(es);
            await flush();
            expect(group.Locale).toBe('es');

            context.useLocale('fr');
            expect(group.Locale).toBe('es');
            expect(group.Current).toBe(es);
            expect(loadFr.loader).toHaveBeenCalledTimes(1);

            loadFr.calls[0].resolve(fr);
            await flush();
            expect(group.Locale).toBe('fr');
            expect(group.Current).toBe(fr);
        });

        describe('preload', () => {

            it('loads the language that the argument resolves to, and leaves what the group shows to the context', async () => {
                const { context, group, loader, calls } = setup();

                const loading = group.preload('es-MX');
                expect(loader).toHaveBeenCalledTimes(1);
                calls[0].resolve(es);
                await loading;
                expect(group.Locale).toBe('en');

                context.useLocale('es-MX');
                expect(group.Locale).toBe('es');
                expect(group.Current).toBe(es);

                const again = group.preload('es');
                expect(loader).toHaveBeenCalledTimes(1);
                await again;
            });

            it('resolves at once for an inline language, a loaded one, and one the group lacks', async () => {
                const { group, loader } = setup();
                const inline = new LocalizedStrings('en', en, { others: { es } });

                await expect(group.preload('en')).resolves.toBeUndefined();
                await expect(group.preload('fr')).resolves.toBeUndefined();
                await expect(inline.preload('es')).resolves.toBeUndefined();
                expect(loader).not.toHaveBeenCalled();
            });

            it('rejects with the loader error as cause, and a later call runs the loader again', async () => {
                const { context, group, loader, calls } = setup();
                const failure = new Error('network');

                const failed = group.preload('es').catch((error: unknown) => error);
                calls[0].reject(failure);
                const error = await failed as Error;

                expect(error).toBeInstanceOf(Error);
                expect(error.message).toMatch(/\bes\b/);
                expect(error.cause).toBe(failure);

                const retry = group.preload('es');
                expect(loader).toHaveBeenCalledTimes(2);
                calls[1].resolve(es);
                await retry;

                context.useLocale('es');
                expect(group.Current).toBe(es);
            });

            it('logs the failure besides rejecting', async () => {
                const { group, calls } = setup();
                const error = vi.fn();
                group.setLogger({ log: vi.fn(), warn: vi.fn(), error });

                const failed = group.preload('es').catch(() => undefined);
                calls[0].reject(new Error('network'));
                await failed;

                expect(error).toHaveBeenCalledTimes(1);
            });
        });

        describe('failed load started by a read', () => {

            it('is logged, shows the default, and is not retried by a read', async () => {
                const { context, group, loader, calls } = setup();
                const error = vi.fn();
                group.setLogger({ log: vi.fn(), warn: vi.fn(), error });
                const failure = new Error('network');

                context.useLocale('es');
                void group.Current;
                calls[0].reject(failure);
                await flush();

                expect(error).toHaveBeenCalledTimes(1);
                expect((error.mock.calls[0][0] as Error).cause).toBe(failure);
                expect(group.Locale).toBe('en');
                expect(group.Current).toBe(en);

                void group.Current;
                void group.Locale;
                expect(loader).toHaveBeenCalledTimes(1);
            });

            it('is logged to the context when the group has no logger, and to the group when it has one', async () => {
                const context = new LocaleContext();
                const contextError = vi.fn();
                context.setLogger({ log: vi.fn(), warn: vi.fn(), error: contextError });
                const withoutLogger = setup(context);
                const withLogger = setup(context);
                const groupError = vi.fn();
                withLogger.group.setLogger({ log: vi.fn(), warn: vi.fn(), error: groupError });

                context.useLocale('es');
                void withoutLogger.group.Current;
                void withLogger.group.Current;
                withoutLogger.calls[0].reject(new Error('network'));
                withLogger.calls[0].reject(new Error('network'));
                await flush();

                expect(contextError).toHaveBeenCalledTimes(1);
                expect(groupError).toHaveBeenCalledTimes(1);
            });
        });

        describe('loader result', () => {

            it('is a failed load when it is not a plain object', async () => {
                const { context, group, loader, calls } = setup();
                const error = vi.fn();
                group.setLogger({ log: vi.fn(), warn: vi.fn(), error });

                context.useLocale('es');
                void group.Current;
                calls[0].resolve(undefined as unknown as Strings);
                await flush();

                expect(error).toHaveBeenCalledTimes(1);
                expect(group.Locale).toBe('en');
                expect(group.Current).toBe(en);

                const preloading = group.preload('es').catch((e: unknown) => e);
                expect(loader).toHaveBeenCalledTimes(2);
                calls[1].resolve(undefined as unknown as Strings);

                const rejection = await preloading as Error;
                expect(rejection.message).toMatch(/\bes\b/);
                expect(group.Current).toBe(en);
            });

            it('is called with no arguments, also on a retry', async () => {
                const { group, loader, calls } = setup();

                const first = group.preload('es').catch(() => undefined);
                calls[0].reject(new Error('network'));
                await first;

                const retry = group.preload('es');
                calls[1].resolve(es);
                await retry;

                expect(loader.mock.calls).toEqual([[], []]);
            });
        });

        describe('storage', () => {

            it('writes a box when a load finishes', async () => {
                const recording = createRecordingStorage();
                const context = new LocaleContext({ storage: recording.storage });
                const { group, calls } = setup(context);
                context.useLocale('es');
                void group.Current;

                const before = recording.totalWrites();
                calls[0].resolve(es);
                await flush();

                expect(recording.totalWrites()).toBeGreaterThan(before);
            });

            it('creates no box at construction, so the context can still be configured', () => {
                const context = new LocaleContext();
                setup(context);

                expect(() => context.configure({ storage: createRecordingStorage().storage })).not.toThrow();
            });
        });
    });

    describe('types', () => {

        it('checks the shape of other languages and of patches', () => {
            const group = createGroup();

            // @ts-expect-error a language missing a key
            new LocalizedStrings('en', { a: 'A', b: 'B' }, { others: { es: { a: 'A' } } });
            // @ts-expect-error an extra key in an inline language
            new LocalizedStrings('en', { a: 'A' }, { others: { es: { a: 'A', c: 'C' } } });

            // @ts-expect-error a patch for a language the group lacks
            group.patch({ fr: { buttons: { save: 'Enregistrer' } } });
            // @ts-expect-error a patch cannot add a key
            group.patch({ en: { unknown: 'x' } });
            // @ts-expect-error a patch value keeps its type
            group.patch({ en: { buttons: { save: 1 } } });
            // @ts-expect-error an array in a patch is replaced whole, so its elements are complete
            group.patch({ en: { rows: [{ id: 'z' }] } });

            group.patch({ en: { buttons: { cancel: 'Dismiss' } }, es: {} });
        });

        it('checks the shape of a loader, and mixes inline and lazy languages', () => {
            const lazy = (strings: { a: string }) => () => Promise.resolve(strings);

            // @ts-expect-error a loader that returns the wrong shape
            new LocalizedStrings('en', { a: 'A', b: 'B' }, { others: { es: lazy({ a: 'A' }) } });
            // @ts-expect-error a loader that returns another type
            new LocalizedStrings('en', { a: 'A' }, { others: { es: () => Promise.resolve({ a: 1 }) } });

            const mixed = new LocalizedStrings('en', { a: 'A' }, { others: { es: { a: 'A' }, fr: lazy({ a: 'A' }) } });
            const locale: 'en' | 'es' | 'fr' = mixed.Locale;

            expect(locale).toBe('en');
        });

        it('types the strings and the resolved language', () => {
            const group = createGroup();
            const alone = new LocalizedStrings('en', en, { context: new LocaleContext() });

            const save: string = group.Current.buttons.save;
            const locale: 'en' | 'es' = group.Locale;
            // @ts-expect-error the resolved language may be any of the group's languages
            const onlyEn: 'en' = group.Locale;
            const aloneLocale: 'en' = alone.Locale;

            expect([save, locale, onlyEn, aloneLocale]).toHaveLength(4);
        });

        it('takes only a complete value for a member that mixes strings and objects', () => {
            const strings: { items: string | { one: string, other: string }, buttons: { save: string, cancel: string } } = {
                items: 'Items',
                buttons: { save: 'Save', cancel: 'Cancel' },
            };
            const group = new LocalizedStrings('en', strings);

            // @ts-expect-error a member that may be a string takes a complete value
            group.patch({ en: { items: { one: 'Item' } } });

            group.patch({ en: { items: { one: 'Item', other: 'Items' } } });
            group.patch({ en: { items: 'Things' } });
            group.patch({ en: { buttons: { cancel: 'Dismiss' } } });

            expect(group.Current.buttons.cancel).toBe('Dismiss');
        });
    });
});
