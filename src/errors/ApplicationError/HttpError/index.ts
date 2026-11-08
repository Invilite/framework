import {ApplicationError} from "../../ApplicationError";

export default class HttpError extends ApplicationError {
    protected readonly httpCode: number;
    protected readonly response: undefined | string;
    protected readonly redirect: undefined | string;

    public constructor(message: string, httpCode: number = 500, response?: string | Buffer, redirect?: string) {
        super(message);
        this.name = 'HttpError';
        this.httpCode = httpCode;
        this.redirect = redirect;

        if (response instanceof Buffer) {
            this.response = response.toString('utf-8');
        } else {
            this.response = response as string;
        }

        Object.setPrototypeOf(this, new.target.prototype);
    }

    public getHttpCode(): number {
        return this.httpCode;
    }

    public getResponse(): undefined | string {
        return this.response;
    }

    public getRedirect(): string | undefined {
        return this.redirect;
    }
}

export {BadRequestError} from "./BadRequestError";

export {UnauthorizedError} from "./UnauthorizedError";
export {LoginRequiredError} from "./LoginRequiredError";

export {PaymentRequiredError} from "./PaymentRequiredError";

export {ForbiddenError} from "./ForbiddenError";

export {NotFoundError} from "./NotFoundError";

export {MethodNotAllowedError} from "./MethodNotAllowedError";

export {NotAcceptableError} from "./NotAcceptableError";

export {ProxyAuthenticationRequiredError} from "./ProxyAuthenticationRequiredError";

export {RequestTimeoutError} from "./RequestTimeoutError";

export {ConflictError} from "./ConflictError";

export {GoneError} from "./GoneError";

export {LengthRequiredError} from "./LengthRequiredError";

export {PreconditionFailedError} from "./PreconditionFailedError";

export {PayloadTooLargeError} from "./PayloadTooLargeError";

export {RequestURITooLongError} from "./RequestURITooLongError";

export {UnsupportedMediaTypeError} from "./UnsupportedMediaTypeError";

export {RangeNotSatisfiableError} from "./RangeNotSatisfiableError";

export {ExpectationFailedError} from "./ExpectationFailedError";

export {MisdirectedRequestError} from "./MisdirectedRequestError";

export {UnprocessableEntityError} from "./UnprocessableEntityError";

export {LockedError} from "./LockedError";

export {FailedDependencyError} from "./FailedDependencyError";

export {TooEarlyError} from "./TooEarlyError";

export {UpgradeRequiredError} from "./UpgradeRequiredError";

export {PreconditionRequiredError} from "./PreconditionRequiredError";

export {TooManyRequestsError} from "./TooManyRequestsError";

export {RequestHeaderFieldsTooLargeError} from "./RequestHeaderFieldsTooLargeError";

export {UnavailableForLegalReasonsError} from "./UnavailableForLegalReasonsError";

export {InternalServerErrorError} from "./InternalServerErrorError";

export {NotImplementedError} from "./NotImplementedError";

export {BadGatewayError} from "./BadGatewayError";

export {ServiceUnavailableError} from "./ServiceUnavailableError";

export {GatewayTimeoutError} from "./GatewayTimeoutError";

export {HTTPVersionNotSupportedError} from "./HTTPVersionNotSupportedError";

export {VariantAlsoNegotiatesError} from "./VariantAlsoNegotiatesError";

export {InsufficientStorageError} from "./InsufficientStorageError";

export {LoopDetectedError} from "./LoopDetectedError";

export {NotExtendedError} from "./NotExtendedError";

export {NetworkAuthenticationRequiredError} from "./NetworkAuthenticationRequiredError";
