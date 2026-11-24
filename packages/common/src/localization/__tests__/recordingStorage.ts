import type { IValueModel, ValueStorageProvider } from '../../models/types.js';

/** A storage provider whose boxes count their reads and writes. */
export function createRecordingStorage() {
    const boxes: RecordedBox<unknown>[] = [];

    const storage: ValueStorageProvider = {
        createValue: <V>(initial: V) => {
            const box = new RecordedBox(initial);
            boxes.push(box);
            return box;
        },
    };

    return {
        storage,
        boxes,
        totalReads: () => boxes.reduce((sum, box) => sum + box.reads, 0),
        totalWrites: () => boxes.reduce((sum, box) => sum + box.writes, 0),
    };
}

class RecordedBox<V> implements IValueModel<V> {
    public reads = 0;
    public writes = 0;

    constructor(private _value: V) { }

    public get value(): V {
        this.reads += 1;
        return this._value;
    }

    public set value(next: V) {
        this.writes += 1;
        this._value = next;
    }
}
