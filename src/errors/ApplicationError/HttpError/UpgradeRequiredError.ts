import HttpError from "./index";
import {HttpStatusCodes} from "../../../types/enums/HttpStatusCodes";

export class UpgradeRequiredError extends HttpError {
    public constructor(message: string, response?: string | Buffer) {
        super(message, HttpStatusCodes.UPGRADE_REQUIRED, response);
        this.name = 'UpgradeRequiredError';
    }
}