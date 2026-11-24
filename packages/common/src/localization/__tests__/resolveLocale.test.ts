import { resolveLocale } from '../resolveLocale.js';

describe('resolveLocale', () => {

    const available = ['en', 'es', 'es-MX', 'pt-BR'] as const;

    it('matches exactly', () => {
        expect(resolveLocale('es', available, 'en')).toBe('es');
        expect(resolveLocale('es-MX', available, 'en')).toBe('es-MX');
    });

    it('prefers an exact match over the base language', () => {
        expect(resolveLocale('es-MX', ['es', 'es-MX'], 'es')).toBe('es-MX');
    });

    it('ignores case and returns the entry spelled as in available', () => {
        expect(resolveLocale('ES', available, 'en')).toBe('es');
        expect(resolveLocale('pt-br', available, 'en')).toBe('pt-BR');
    });

    it('treats - and _ alike on both sides', () => {
        expect(resolveLocale('pt_BR', available, 'en')).toBe('pt-BR');
        expect(resolveLocale('pt-br', ['en', 'pt_BR'], 'en')).toBe('pt_BR');
    });

    it('falls back to the base language of a regional request', () => {
        expect(resolveLocale('en-US', available, 'es')).toBe('en');
        expect(resolveLocale('es_AR', available, 'en')).toBe('es');
    });

    it('tries each shorter prefix, longest first', () => {
        expect(resolveLocale('zh-Hant-TW', ['en', 'zh', 'zh-Hant'], 'en')).toBe('zh-Hant');
        expect(resolveLocale('zh-Hant-TW', ['en', 'zh-Hans', 'zh-Hant'], 'en')).toBe('zh-Hant');
        expect(resolveLocale('zh_hant_tw', ['en', 'zh', 'zh-Hant'], 'en')).toBe('zh-Hant');
        expect(resolveLocale('zh-Hant-TW', ['en', 'zh'], 'en')).toBe('zh');
        expect(resolveLocale('zh-Hant-TW', ['en', 'zh-Hans'], 'en')).toBe('en');
    });

    it('does not match a base language request to a regional variant', () => {
        expect(resolveLocale('pt', available, 'en')).toBe('en');
        expect(resolveLocale('en', ['es', 'en-US'], 'es')).toBe('es');
    });

    it('returns the fallback when nothing matches', () => {
        expect(resolveLocale('fr', available, 'en')).toBe('en');
        expect(resolveLocale('fr-CA', available, 'es')).toBe('es');
    });

    it('returns the fallback when no language is requested', () => {
        expect(resolveLocale(null, available, 'es')).toBe('es');
        expect(resolveLocale(undefined, available, 'es')).toBe('es');
        expect(resolveLocale('', available, 'es')).toBe('es');
    });
});
