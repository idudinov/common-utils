import type { IValueModel } from '@zajno/common/models/types';
import type { PromiseCacheStorageProvider } from '@zajno/common/structures/promiseCache';
import { isObservable, observable, runInAction } from 'mobx';
import { ValueModel } from './viewModels/ValueModel.js';

/**
 * Converts `value` into an observable copy of the given depth, unless it's a primitive, `null`,
 * or already observable — those pass through untouched.
 */
export function toObservableValue<V>(value: V, deep: boolean): V {
    if (value === null || typeof value !== 'object' || isObservable(value)) {
        return value;
    }
    return observable(value as object, undefined, { deep }) as V;
}

/**
 * Supplies bare mobx-observable maps/boxes, relying on `transaction` (wired to `runInAction`)
 * for action wrapping — callers must not wrap individual mutations themselves.
 */
export const mobxStorageProvider: PromiseCacheStorageProvider = {
    createMap: <K, V>() => observable.map<K, V>(undefined, { deep: false }),
    createValue: <V>(initial: V) => {
        // ValueModel's constructor takes `v` as a defaulted param, so an explicit `undefined` argument
        // there is indistinguishable from "omitted" and would be coerced to `null`; assign separately instead.
        const box = new ValueModel<V>() as IValueModel<V>;
        box.value = initial;
        return box;
    },
    transaction: fn => runInAction(fn),
};
