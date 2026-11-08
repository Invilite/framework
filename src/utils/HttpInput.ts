import {ExtendedRequest} from '../models/ExtendedRequest';

export interface NullableIntegerResult {
    valid: boolean;
    value: number | null;
}

export class HttpInput {
    public static body(request: ExtendedRequest): Record<string, unknown> {
        if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
            return {};
        }
        return request.body as Record<string, unknown>;
    }

    public static userId(request: ExtendedRequest): number | null {
        const auth: { metadata?: { userId?: number; }; } | undefined = request.auth as {metadata?: {userId?: number}} | undefined;
        const userId: number | undefined = auth?.metadata?.userId;
        return typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0 ? userId : null;
    }

    public static requiredUserId(request: ExtendedRequest): number {
        const userId: number | null = HttpInput.userId(request);
        if (userId === null) {
            throw new Error('Authenticated request is missing a user identifier.');
        }
        return userId;
    }

    public static positiveInteger(raw: unknown): number | null {
        const value: number = Number(raw);
        return Number.isSafeInteger(value) && value > 0 ? value : null;
    }

    public static nullableInteger(value: unknown): NullableIntegerResult {
        if (value === null || value === undefined || value === '') {
            return {valid: true, value: null};
        }
        if (typeof value === 'number' && Number.isSafeInteger(value)) {
            return {valid: true, value};
        }
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
            return {valid: true, value: Number(value.trim())};
        }
        return {valid: false, value: null};
    }
}

export default HttpInput;
