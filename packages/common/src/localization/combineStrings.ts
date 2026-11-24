import type { AnyObject } from '../types/misc.js';
import type { ILocalization } from './abstractions.js';

type Parts = Record<string, ILocalization<AnyObject>>;

type StringsOf<T> = T extends ILocalization<infer S> ? S : never;

type PartsStrings<TParts extends Parts> = { [K in keyof TParts]: StringsOf<TParts[K]> };

/**
 * Combines groups of strings into one object, each part under the key it is given.
 *
 * Current:
 * - stays the same object until a part's `Current` changes
 */
export function combineStrings<TParts extends Parts>(parts: TParts): ILocalization<PartsStrings<TParts>>;
/**
 * Combines a root group and other groups of strings into one object.
 *
 * Shape:
 * - the root's keys sit at the top level
 * - each part sits under the key it is given
 * - a part key that the root already has is a type error, unless the root has an index signature
 *
 * Current:
 * - stays the same object until the root's or a part's `Current` changes
 */
export function combineStrings<TRoot extends AnyObject, TParts extends Parts>(
    root: ILocalization<TRoot>,
    parts: TParts & (string extends keyof TRoot ? unknown : { [K in keyof TParts & keyof TRoot]: never }),
): ILocalization<TRoot & PartsStrings<TParts>>;
export function combineStrings(rootOrParts: ILocalization<AnyObject> | Parts, parts?: Parts): ILocalization<AnyObject> {
    return parts
        ? new CombinedStrings(rootOrParts as ILocalization<AnyObject>, parts)
        : new CombinedStrings(undefined, rootOrParts as Parts);
}

class CombinedStrings implements ILocalization<AnyObject> {
    private readonly _keys: readonly string[];
    private readonly _sources: readonly ILocalization<AnyObject>[];

    private readonly _inputs: AnyObject[] = [];
    private _combined: AnyObject = {};

    constructor(private readonly _root: ILocalization<AnyObject> | undefined, parts: Parts) {
        this._keys = Object.keys(parts);
        this._sources = _root ? [_root, ...Object.values(parts)] : Object.values(parts);
    }

    public get Current(): AnyObject {
        let changed = false;

        // Every source is read on every call, so none is hidden from whoever tracks reads.
        for (let i = 0; i < this._sources.length; i++) {
            const current = this._sources[i].Current;
            if (this._inputs[i] !== current) {
                this._inputs[i] = current;
                changed = true;
            }
        }

        if (changed) {
            this._combined = this.build();
        }

        return this._combined;
    }

    private build(): AnyObject {
        const offset = this._root ? 1 : 0;
        const result: AnyObject = this._root ? { ...this._inputs[0] } : {};
        this._keys.forEach((key, i) => {
            result[key] = this._inputs[i + offset];
        });
        return result;
    }
}
