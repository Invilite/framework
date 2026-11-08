import {WithId} from "./WithId";

export type OptionalWithId<T, R = any> = T | WithId<T, R>;