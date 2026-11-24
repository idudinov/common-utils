import type { AnyObject } from '../types/misc.js';

export interface ILocalization<TStrings extends AnyObject> {
    readonly Current: Readonly<TStrings>;
}

export interface IErrorsLocalization<TErrors extends string | number> {
    readonly Errors: ValidationErrorsStrings<TErrors>
}

export type StringsLoader<TStrings> = TStrings | (() => Promise<TStrings>);
export type StringsDataSource<TLocale extends string, TStrings extends AnyObject> = Record<TLocale, StringsLoader<TStrings>>;

export type LocaleStrings<TLocale extends string, TStrings extends AnyObject> = {
    locale: TLocale;
    strings: TStrings;
};

/**
 * Deep-partial of `T` for overriding some of its values.
 *
 * Members:
 * - a nested plain object is partial
 * - a function or an array is kept whole
 * - a member whose type mixes primitives and objects takes only a complete value
 */
export type StringsPatch<T> = [T] extends [object] ? PatchObject<T> : T;

type PatchObject<T> = T extends (...args: never[]) => unknown ? T
    : T extends readonly unknown[] ? T
    : { [K in keyof T]?: StringsPatch<T[K]> };

export type ValidationErrorsStrings<T extends string | number> = Partial<Record<T, string>>;

export type ValidationErrorsFactory<TStrings extends AnyObject, TErrors extends string | number> = (strings: TStrings) => ValidationErrorsStrings<TErrors>;
