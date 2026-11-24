import type { ValueStorageProvider } from '../../models/types.js';
import { LocaleContext } from '../LocaleContext.js';
import { createRecordingStorage } from './recordingStorage.js';

describe('LocaleContext', () => {

    it('switches the language synchronously', () => {
        const context = new LocaleContext();
        expect(context.Locale).toBeNull();

        context.useLocale('es');
        expect(context.Locale).toBe('es');

        context.useLocale(null);
        expect(context.Locale).toBeNull();
    });

    it('fires localeChanged with the new language only when the language changes', () => {
        const context = new LocaleContext();
        const handler = vi.fn();
        context.localeChanged.on(handler);

        context.configure({ locale: 'en' });
        context.configure({ locale: 'en' });
        context.useLocale('en');
        context.useLocale('es');
        context.useLocale(null);

        expect(handler.mock.calls).toEqual([['en'], ['es'], [null]]);
    });

    it('takes the initial language from the constructor and from configure', () => {
        expect(new LocaleContext({ locale: 'es' }).Locale).toBe('es');

        const context = new LocaleContext();
        context.configure({ locale: 'es-MX' });
        expect(context.Locale).toBe('es-MX');
    });

    it('keeps options that configure omits', () => {
        const { storage, boxes } = createRecordingStorage();
        const context = new LocaleContext({ locale: 'es', storage });

        context.configure({ locale: 'en' });
        context.configure({});

        expect(context.Locale).toBe('en');
        expect(boxes).toHaveLength(1);
    });

    it('creates boxes from the configured storage', () => {
        const { storage, boxes } = createRecordingStorage();
        const context = new LocaleContext({ storage });

        const box = context.createValue(5);
        expect(boxes).toContain(box);

        context.useLocale('es');
        expect(boxes.some(b => b.writes > 0)).toBe(true);
    });

    it('creates plain boxes with no storage configured', () => {
        const box = new LocaleContext().createValue({ a: 1 });
        const next = { a: 2 };

        box.value = next;
        expect(box.value).toBe(next);
    });

    it('runs a transaction through the configured storage, and directly without one', () => {
        let batches = 0;
        const batching: ValueStorageProvider = {
            ...createRecordingStorage().storage,
            transaction: <R>(fn: () => R) => {
                batches += 1;
                return fn();
            },
        };
        const fn = vi.fn(() => 'result');

        expect(new LocaleContext({ storage: batching }).transaction(fn)).toBe('result');
        expect(batches).toBe(1);
        expect(fn).toHaveBeenCalledTimes(1);

        expect(new LocaleContext({ storage: createRecordingStorage().storage }).transaction(fn)).toBe('result');
        expect(batches).toBe(1);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('creates no box until one is needed', () => {
        const { storage, boxes } = createRecordingStorage();
        const context = new LocaleContext({ storage, locale: 'es' });
        expect(boxes).toHaveLength(0);

        expect(context.Locale).toBe('es');
        expect(boxes).toHaveLength(1);
    });

    describe('configure after a box is created', () => {

        it('throws after the language is read', () => {
            const context = new LocaleContext();
            void context.Locale;

            expect(() => context.configure({ locale: 'es' })).toThrow();
        });

        it('throws after the language is switched', () => {
            const context = new LocaleContext();
            context.useLocale('es');

            expect(() => context.configure({ storage: createRecordingStorage().storage })).toThrow();
        });

        it('throws after a group asks for a box', () => {
            const context = new LocaleContext();
            context.createValue(0);

            expect(() => context.configure({})).toThrow();
        });

        it('keeps the context as it was', () => {
            const context = new LocaleContext({ locale: 'es' });
            void context.Locale;
            const changed = vi.fn();
            context.localeChanged.on(changed);
            const { storage, boxes } = createRecordingStorage();

            expect(() => context.configure({ locale: 'en', storage })).toThrow();

            expect(context.Locale).toBe('es');
            expect(changed).not.toHaveBeenCalled();

            context.createValue(0);
            expect(boxes).toHaveLength(0);
        });
    });
});
