/** Applies `extendShape` and enforces in-place augmentation: throws if it returns a different instance. */
export function applyExtensionShape<TTarget extends object, TShape extends object>(
    target: TTarget,
    extendShape: ((previous: TTarget) => TTarget & TShape) | undefined,
): TTarget & TShape {
    if (!extendShape) {
        return target as TTarget & TShape;
    }

    const result = extendShape(target);
    if (result !== (target as unknown)) {
        throw new Error('extendShape must augment the given instance in place and return it');
    }

    return result;
}
