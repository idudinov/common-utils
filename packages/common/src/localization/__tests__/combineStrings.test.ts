import type { ILocalization } from '../abstractions.js';
import { combineStrings } from '../combineStrings.js';
import { LocaleContext } from '../LocaleContext.js';
import { LocalizationManager } from '../LocalizationManager.js';
import { LocalizedStrings } from '../LocalizedStrings.js';
import { createRecordingStorage } from './recordingStorage.js';

describe('combineStrings', () => {

    const setup = (context = new LocaleContext()) => {
        const App = new LocalizedStrings('en', { Common: { ok: 'OK' } }, { others: { es: { Common: { ok: 'Vale' } } }, context });
        const Ui = new LocalizedStrings('en', { buttons: { save: 'Save' } }, { others: { es: { buttons: { save: 'Guardar' } } }, context });
        const Api = new LocalizedStrings('en', { Validation: { required: 'Required' } }, { context });
        return { context, App, Ui, Api };
    };

    it('puts the root keys at the top level and each part under its key', () => {
        const { App, Ui, Api } = setup();
        const combined = combineStrings(App, { Ui, Api });

        expect(combined.Current.Common).toBe(App.Current.Common);
        expect(combined.Current.Ui).toBe(Ui.Current);
        expect(combined.Current.Api).toBe(Api.Current);
    });

    it('combines parts without a root', () => {
        const { Ui, Api } = setup();
        const combined = combineStrings({ Ui, Api });

        expect(combined.Current.Ui).toBe(Ui.Current);
        expect(combined.Current.Api).toBe(Api.Current);
        expect(Object.keys(combined.Current)).toEqual(['Ui', 'Api']);
    });

    it('does not change the root strings', () => {
        const { App, Ui } = setup();
        const combined = combineStrings(App, { Ui });

        expect(combined.Current).not.toBe(App.Current);
        expect(Object.keys(App.Current)).not.toContain('Ui');
    });

    it('follows the language of its parts', () => {
        const { context, App, Ui, Api } = setup();
        const combined = combineStrings(App, { Ui, Api });

        context.useLocale('es');

        expect(combined.Current.Common).toBe(App.Current.Common);
        expect(combined.Current.Ui.buttons.save).toBe(Ui.Current.buttons.save);
        expect(combined.Current.Ui.buttons.save).not.toBe('Save');
        expect(combined.Current.Api).toBe(Api.Current);
    });

    it('accepts any localization as a part', () => {
        const { App } = setup();
        const manager = new LocalizationManager({ en: { hello: 'Hello' } }, 'en', { hello: 'Hello' });
        const combined = combineStrings(App, { Manager: manager });

        expect(combined.Current.Manager).toBe(manager.Current);
    });

    describe('identity', () => {

        it('keeps the same object while nothing changes', () => {
            const { App, Ui, Api } = setup();
            const combined = combineStrings(App, { Ui, Api });

            expect(combined.Current).toBe(combined.Current);
        });

        it('returns a new object when a part changes, and keeps the other parts', () => {
            const { App, Ui, Api } = setup();
            const combined = combineStrings(App, { Ui, Api });
            const before = combined.Current;

            Ui.patch({ en: { buttons: { save: 'Store' } } });

            expect(combined.Current).not.toBe(before);
            expect(combined.Current.Ui.buttons.save).toBe('Store');
            expect(combined.Current.Api).toBe(before.Api);
            expect(combined.Current.Common).toBe(before.Common);
        });

        it('returns a new object when the root changes', () => {
            const { App, Ui } = setup();
            const combined = combineStrings(App, { Ui });
            const before = combined.Current;

            App.patch({ en: { Common: { ok: 'Fine' } } });

            expect(combined.Current).not.toBe(before);
            expect(combined.Current.Common.ok).toBe('Fine');
            expect(combined.Current.Ui).toBe(before.Ui);
        });

        it('returns a new object when the language changes', () => {
            const { context, App, Ui } = setup();
            const combined = combineStrings(App, { Ui });
            const before = combined.Current;

            context.useLocale('es');

            expect(combined.Current).not.toBe(before);
        });
    });

    describe('storage', () => {

        it('reads every box on each read, also when the cached object is returned', () => {
            const { storage, boxes } = createRecordingStorage();
            const { App, Ui, Api } = setup(new LocaleContext({ storage }));
            const combined = combineStrings(App, { Ui, Api });
            void [App.Current, Ui.Current, Api.Current];

            const first = combined.Current;
            expect(boxes.length).toBeGreaterThan(0);

            const reads = boxes.map(box => box.reads);
            expect(combined.Current).toBe(first);

            boxes.forEach((box, i) => expect(box.reads).toBeGreaterThan(reads[i]));
        });
    });

    describe('types', () => {

        it('types the combined strings, and rejects a part key the root already has', () => {
            const { App, Ui, Api } = setup();
            const combined = combineStrings(App, { Ui, Api });

            const ok: string = combined.Current.Common.ok;
            const save: string = combined.Current.Ui.buttons.save;
            const required: string = combined.Current.Api.Validation.required;

            // @ts-expect-error the part key collides with a root key
            combineStrings(App, { Common: Ui });

            const indexed: ILocalization<Record<string, string>> = { Current: { ok: 'OK' } };
            const withIndexed = combineStrings(indexed, { Ui });

            // @ts-expect-error the combined object cannot be patched
            void combined.patch;
            // @ts-expect-error the combined object has no language of its own
            void combined.Locale;

            expect([ok, save, required, withIndexed.Current.Ui]).toHaveLength(4);
        });
    });
});
