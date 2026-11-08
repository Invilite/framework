import {JwtPayload} from "jsonwebtoken";
import {ExtendedRequest} from "./ExtendedRequest";

export interface AuthorizedRequest extends ExtendedRequest {
    auth: JwtPayload & {
        metadata: {
            userId: number;
            username: string;
        }
    }
}