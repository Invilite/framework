
export class Type {

    public static IsObject(value: unknown): value is object {
        return typeof value === "object" && value !== null;
    }
}