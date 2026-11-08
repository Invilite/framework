import * as util from "util";

export function SecretGuard <T extends { new(...args: any[]): {} }>(constructor: T): any {
    const message: string = "This class contains sensitive data and cannot be serialised.";
    return class extends constructor {

        public toString(): string {
            return `[SecretGuard: ${message}]`;
        }

        public toJSON(): object {
            return { SecretGuard: `[${message}]` };
        }

        public [util.inspect.custom](): string {
            return `[SecretGuard: ${message}]`;
        }
    };
}