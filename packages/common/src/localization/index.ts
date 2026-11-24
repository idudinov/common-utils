import { combineStrings } from './combineStrings.js';
import { LocaleContext } from './LocaleContext.js';
import { LocalizationManager } from './LocalizationManager.js';
import { LocalizedStrings } from './LocalizedStrings.js';
import { LocalizedValidationErrors } from './LocalizedValidationErrors.js';
import { resolveLocale } from './resolveLocale.js';

export type * from './abstractions.js';
export type { LocaleContextOptions } from './LocaleContext.js';
export type { LocalizedStringsOptions } from './LocalizedStrings.js';

export {
    combineStrings,
    LocaleContext,
    LocalizationManager,
    LocalizedStrings,
    LocalizedValidationErrors,
    resolveLocale,
};
