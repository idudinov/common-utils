
export interface IValueModelReadonly<TValue> {
    readonly value: TValue;
}

export interface IValueModel<TValue> extends IValueModelReadonly<TValue> {
    value: TValue;
}

/** Supplies the value box backing a consumer's internal state. */
export interface ValueStorageProvider {
    /**
     * Creates a single-value box initialized to `initial`. Called during construction.
     * Must be identity-preserving for non-function values; function-typed values need not be supported.
     */
    createValue<V>(initial: V): IValueModel<V>;

    /**
     * Runs a group of mutations as one change batch and returns `fn`'s result. Called synchronously
     * with a function that itself must run synchronously — never wrap an `await` in it.
     *
     * Must support nesting: a transaction started inside another joins the outer batch.
     *
     * When omitted, groups are not batched: `fn` is invoked immediately, uncoordinated with other mutations.
     */
    transaction?<R>(fn: () => R): R;
}

export interface ILabel<T> {
    readonly label: T;
}

export interface IResettableModel {
    readonly reset: () => void;
    readonly isDefault?: boolean;
}

export interface IFocusableModel {
    focused: boolean;
}

export interface IErrorModel {
    readonly error: string;
}

export interface ICountableModel {
    readonly count: number;
    readonly selectedCount?: number;
    readonly isEmpty: boolean;
}

/** Lighter version of ES2015 Map with no constructor/symbols stuff. */
export type IMapModel<K, V> = Pick<
    Map<K, V>,
    | 'clear'
    | 'delete'
    | 'get'
    | 'has'
    | 'set'
    | 'size'
    | 'entries'
    | 'keys'
    | 'values'
    | 'forEach'
>;
