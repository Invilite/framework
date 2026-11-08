import {Url} from "./Url";
const { env } = require('node:process');

export class Env {

    public static getNumber(name: string): number | undefined;
    public static getNumber(name: string, defValue: number): number;
    public static getNumber(name: string, defValue?: number): number | undefined {
        const value: number = parseInt(env[name] ?? '', 10);

        if (!isNaN(value)) {
            return value;
        }

        return defValue;
    }

    public static getString(name: string): string | undefined;
    public static getString(name: string, defValue: string): string;
    public static getString(name: string, defValue?: string): string | undefined {
        const value: string | undefined = env[name];

        if (typeof value === 'string') {
            return value;
        }

        return defValue;
    }

    public static getBoolean(name: string): boolean | undefined;
    public static getBoolean(name: string, defValue: boolean): boolean;
    public static getBoolean(name: string, defValue?: boolean): boolean | undefined {
        const value: string | undefined = env[name];

        if (typeof value === 'string') {
            const normalized: string = value.trim().toLowerCase();

            if (normalized === 'true' || normalized === '1') {
                return true;
            }

            if (normalized === 'false' || normalized === '0') {
                return false;
            }
        }

        return defValue;
    }

    /** Required base URL without trailing slashes - safe to concatenate with "/path" (no "//"). */
    public static requireUrl(name: string): string {
        return Url.trimTrailingSlash(Env.requireString(name));
    }

    public static requireNumber(name: string): number {
        const value: number | undefined = Env.getNumber(name);

        if (typeof value !== 'number') {
            throw new Error(`Missing environment variable: ${name}`);
        }

        return value;
    }

    public static requireString(name: string): string {
        const value: string | undefined = Env.getString(name);

        if (typeof value !== 'string') {
            throw new Error(`Missing environment variable: ${name}`);
        }

        return value
    }

    public static requireBoolean(name: string): boolean {
        const value: boolean | undefined = Env.getBoolean(name);

        if (typeof value !== 'boolean') {
            throw new Error(`Missing environment variable: ${name}`);
        }

        return value;
    }

    public static isDevelopment(): boolean {
        return (Env.getString('NODE_ENV', 'development') !== 'production');
    }
}
