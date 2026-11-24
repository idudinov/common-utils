/**
 * Picks the entry of `available` that best matches the requested language.
 *
 * Resolution:
 * - an exact match, ignoring case, with `-` and `_` treated alike
 * - then each shorter prefix, longest first: `zh-Hant-TW` tries `zh-Hant`, then `zh`
 * - then `fallback`
 *
 * Not matched:
 * - a requested base language against a regional variant: `en` does not resolve to `en-US`
 *
 * @returns the matching entry spelled as in `available`, or `fallback`
 */
export function resolveLocale<T extends string>(requested: string | null | undefined, available: readonly T[], fallback: T): T {
    if (!requested) {
        return fallback;
    }

    const subtags = normalize(requested).split('-');
    for (let length = subtags.length; length > 0; length--) {
        const wanted = subtags.slice(0, length).join('-');
        const match = available.find(locale => normalize(locale) === wanted);
        if (match !== undefined) {
            return match;
        }
    }

    return fallback;
}

function normalize(locale: string): string {
    return locale.replace(/_/g, '-').toLowerCase();
}
