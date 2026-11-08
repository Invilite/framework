import * as util from "util";
import {Class} from "../utils/Class";
import {String} from "../utils/String";
import {UnloadedFieldError} from "../errors/UnloadedFieldError";

export default abstract class AbstractModel {

    protected _id?: string | number;
    /** Field values (JSON) as last read from the database; null for a model built in code. */
    private _persistedState: Map<string, string> | null = null;

    public getId(): string | number | undefined {
        return this._id;
    }

    public setId(id: string | number): void {
        this._id = id;
    }

    public toString(): string {
        return JSON.stringify(this.toJSON());
    }

    public toJSON(): Record<string, any> {
        const attributes: string[] = Object.getOwnPropertyNames(this)
            .filter((name: string): boolean => !name.startsWith('_') && !AbstractModel.isUnloaded(this, name));
        const data: Record<string, any> = {};
        for (const attr of attributes) {
            data[attr] = (this as any)[attr];
        }

        return data;
    }

    /**
     * Fields changed since the model was hydrated - what an UPDATE may write. Writing the whole model would put back
     * defaults of columns the query did not select and undo concurrent changes of other columns. A model never
     * hydrated has no baseline, so every field counts as changed.
     */
    public getChangedData(): Record<string, any> {
        const data: Record<string, any> = this.toJSON();
        if (this._persistedState === null) {
            return data;
        }

        const changed: Record<string, any> = {};
        for (const [field, value] of Object.entries(data)) {
            if (JSON.stringify(value) !== this._persistedState.get(field)) {
                changed[field] = value;
            }
        }
        return changed;
    }

    public [util.inspect.custom](): string {
        return `${this.constructor.name} ${util.inspect(this.toJSON(), false, null, true)}`;
    }

    public hydrateModel(data?: any, id?: string | number): void {
        const declaredFields: string[] = Object.getOwnPropertyNames(this).filter((name: string): boolean => !name.startsWith('_'));
        const firstHydration: boolean = this._persistedState === null;

        for (const dataName in data) {
            const setMethodName: string = `set${String.capitalizeFirstLetter(dataName)}`;
            if (Class.hasMethod(this, setMethodName)) {
                (this as any)[setMethodName](data[dataName]);
            } else if (Object.hasOwn(this, dataName)) {
                (this as any)[dataName] = data[dataName];
            } else if (Object.hasOwn(this, `_${dataName}`)) {
                (this as any)[`_${dataName}`] = data[dataName];
            }
        }

        if (id) {
            this._id = id;
        }

        // A field whose column the first query did not select must not pass its default off as database state: it
        // becomes an accessor that throws on read and turns back into a plain field when code assigns it.
        if (firstHydration) {
            const loadedFields: Set<string> = new Set<string>(Object.keys(data ?? {}));
            for (const field of declaredFields) {
                if (!loadedFields.has(field)) {
                    AbstractModel.markUnloaded(this, field);
                }
            }
        }

        const state: Map<string, string> = new Map<string, string>();
        for (const [field, value] of Object.entries(this.toJSON())) {
            state.set(field, JSON.stringify(value));
        }
        this._persistedState = state;
    }

    private static markUnloaded(model: AbstractModel, field: string): void {
        Object.defineProperty(model, field, {
            configurable: true,
            enumerable: false,
            get(): never {
                throw new UnloadedFieldError(model.constructor.name, field);
            },
            set(value: unknown): void {
                Object.defineProperty(model, field, {value, writable: true, enumerable: true, configurable: true});
            },
        });
    }

    private static isUnloaded(model: AbstractModel, field: string): boolean {
        return Object.getOwnPropertyDescriptor(model, field)?.get !== undefined;
    }
}