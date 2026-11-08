import 'reflect-metadata';
import express from "express";
import {ExtendedRequest} from "../../models/ExtendedRequest";
import {JwtPayload} from "jsonwebtoken";
import {LoginRequiredError, NotFoundError} from "../../errors/ApplicationError/HttpError";

/** Method metadata with the roles a route requires; WebServer reads it to hide the path's 405 answer too. */
export const REQUIRED_ROLES_METADATA: string = 'RequiredRoles';

/** Set on every method with @RequiresAuth, with or without roles. */
const REQUIRES_LOGIN_METADATA: string = 'RequiresLogin';

/** The method as written, before the HTTP check wrapped it. */
const UNGUARDED_METHOD_METADATA: string = 'UnguardedMethod';

/**
 * What @RequiresAuth demands of a method, null when it has no @RequiresAuth. Socket entry points read it and check
 * the connection themselves, because the HTTP check below reads `auth` from a request in the first argument.
 */
export function readRequiredAuth(target: object, propertyKey: string): {roles: string[] | null} | null {
    if (Reflect.getMetadata(REQUIRES_LOGIN_METADATA, target, propertyKey) !== true) {
        return null;
    }
    const roles: string[] | undefined = Reflect.getMetadata(REQUIRED_ROLES_METADATA, target, propertyKey);

    return {roles: roles ?? null};
}

/** The method without the HTTP check of @RequiresAuth; the method itself when it has none. */
export function unguardedMethod(target: object, propertyKey: string): (...args: unknown[]) => unknown {
    const unguarded: ((...args: unknown[]) => unknown) | undefined = Reflect.getMetadata(UNGUARDED_METHOD_METADATA, target, propertyKey);

    return unguarded ?? (target as Record<string, (...args: unknown[]) => unknown>)[propertyKey];
}

/** A token carries a single role, so every required role must be that one. */
export function hasRequiredRoles(auth: JwtPayload | undefined, roles: string[]): boolean {
    const userRole: string | undefined = auth?.['role'];
    if (!userRole) {
        return false;
    }

    return roles.every((role: string): boolean => role === userRole);
}

/**
 * Without roles a guest is sent to log in (WebServerOptions.loginPath). With roles the route is hidden: anyone without them, a guest included,
 * gets NotFoundError, which WebServer answers exactly like a path that does not exist - a login redirect or a 401
 * would confirm to a scanner that the route is there.
 */
export const RequiresAuth: (roles?: string[]) => MethodDecorator = (roles?: string[]): MethodDecorator => {
    return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void => {
        if (roles) {
            Reflect.defineMetadata(REQUIRED_ROLES_METADATA, roles, target, propertyKey);
        }

        const originalMethod = descriptor.value;
        Reflect.defineMetadata(REQUIRES_LOGIN_METADATA, true, target, propertyKey);
        Reflect.defineMetadata(UNGUARDED_METHOD_METADATA, originalMethod, target, propertyKey);
        descriptor.value = function(request: ExtendedRequest, response: express.Response, next: express.NextFunction) {
            if (roles) {
                if (!hasRequiredRoles(request.auth, roles)) {
                    throw new NotFoundError("User has no access (missing role).");
                }

                return originalMethod.call(this, request, response, next);
            }

            if (!request.auth) {
                throw new LoginRequiredError(request.originalUrl);
            }

            return originalMethod.call(this, request, response, next);
        }
    };
};
