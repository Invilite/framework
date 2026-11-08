import path from "path";

export class Path {
    public static resolve(...paths: string[]): string {
        return path.resolve(...paths);
    }

    public static join(...paths: string[]): string {
        return path.join(...paths);
    }
}