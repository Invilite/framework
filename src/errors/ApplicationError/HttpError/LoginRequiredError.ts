import {UnauthorizedError} from "./UnauthorizedError";

/**
 * A guest reached a page that needs a session. Carries only where to come back to: the login page is the
 * application's (WebServerOptions.loginPath), so no framework code names an application path.
 */
export class LoginRequiredError extends UnauthorizedError {
    public constructor(private readonly returnTo: string) {
        super("No valid authorization header provided.", "User must be authorized to access this resources.");
        this.name = 'LoginRequiredError';
    }

    public getReturnTo(): string {
        return this.returnTo;
    }
}
