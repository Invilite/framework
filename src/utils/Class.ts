type ClassConstructor<T = {}> = new (...args: any[]) => T;

export class Class {
    public static isInheritedFrom(obj: ClassConstructor, superclass: any): boolean {
        if (typeof obj !== 'function') {
            return false;
        }

        if (obj === superclass) {
            return true;
        }

        if (!obj || !obj.prototype) {
            return false;
        }

        let proto = Object.getPrototypeOf(obj.prototype);
        while (proto !== null) {
            if (proto === superclass.prototype) {
                return true;
            }
            proto = Object.getPrototypeOf(proto);
        }

        return false;
    }

    public static hasMethod(obj: any, name: string): boolean {
        return obj[name] && typeof obj[name] === "function";
    }

    public static hasOwnAttribute(obj: any, name: string): boolean {
        return Object.hasOwn(this, name);
    }
}