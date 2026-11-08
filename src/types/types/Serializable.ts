import {TypedArray} from "./TypedArray";

export type Serializable = number | string | boolean | null | undefined | Object | any[] | Map<any, any> | Set<any> | ArrayBuffer | SharedArrayBuffer | Date | RegExp | Error | BigInt | TypedArray;