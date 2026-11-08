import express from "express";
import multer, {Multer, MulterError, StorageEngine} from 'multer';
import {ByteSize} from "../../utils/ByteSize";

const storageEngine: StorageEngine = multer.memoryStorage();
const upload: Multer = multer({ storage: storageEngine });

const ARRAY_MAX_FILE_SIZE_BYTES: number = 50 * 1024 * 1024;
const SINGLE_FIELD_COUNT_LIMIT: number = 20;
const SINGLE_PART_COUNT_LIMIT: number = 25;
const SINGLE_FIELD_SIZE_LIMIT_BYTES: number = 64 * 1024;

export interface UploadOptions {
    /** Per-file limit enforced by multer; an oversized file becomes a JSON 413 response. */
    maxFileSize?: number;
    /** Per-field limit for text parts; defaults to 64 KiB. */
    maxFieldSize?: number;
    /** Per-field-name limit; without it multer keeps its default (unlimited) behaviour. */
    maxFieldNameSize?: number;
}

/**
 * Single-file upload decorator (multer memoryStorage, `request.file`). Without options there is
 * no size limit and multer errors bubble up. With options it builds a dedicated
 * multer instance that decodes filename parameters as UTF-8 (multer defaults to latin1, which
 * mangles Polish names) and bounds the multipart payload; multer errors become a JSON 413/400
 * response so the API client can react, with the human-readable size derived from the configured
 * limit.
 */
export function Upload(fieldName: string = 'file', options?: UploadOptions): MethodDecorator {
    const maxFileSize: number | undefined = options?.maxFileSize;
    const custom: boolean = options !== undefined;
    const instance: Multer = custom
        ? multer({
            storage: storageEngine,
            // multer forwards this to busboy but its @types are behind multer 2.
            defParamCharset: 'utf8',
            limits: {
                fileSize: maxFileSize,
                fields: SINGLE_FIELD_COUNT_LIMIT,
                parts: SINGLE_PART_COUNT_LIMIT,
                fieldSize: options?.maxFieldSize ?? SINGLE_FIELD_SIZE_LIMIT_BYTES,
                fieldNameSize: options?.maxFieldNameSize,
            },
        } as unknown as multer.Options)
        : upload;

    return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;

        descriptor.value = async function(request: express.Request, response: express.Response, next: express.NextFunction): Promise<void> {

            await new Promise<void>((resolve, reject) => {
                instance.single(fieldName)(request, response, (error: unknown): void => {
                    if (error) {
                        if (custom && error instanceof MulterError) {
                            respondWithMulterError(response, error, maxFileSize);
                            return resolve();
                        }

                        return reject(error);
                    }

                    resolve();
                });
            });

            // If the middleware already responded (e.g. multer rejected the request),
            // do not invoke the controller - it would try to send a second response.
            if (response.headersSent || response.writableEnded) {
                return;
            }

            return originalMethod.call(this, request, response, next);
        };

        return descriptor;
    };
}

/**
 * Map a multer error code to an HTTP status and a human-readable message.
 * Used by Upload (with a size limit) and UploadArray to convert multer rejections into JSON API
 * errors so the frontend can react meaningfully (instead of a generic 500).
 */
function mapMulterError(error: MulterError, maxFileSize?: number): { status: number; message: string } {
    switch (error.code) {
        case 'LIMIT_FILE_SIZE':
            return {
                status: 413,
                message: maxFileSize === undefined
                    ? 'Plik przekracza maksymalny dozwolony rozmiar.'
                    : `Plik przekracza maksymalny dozwolony rozmiar (${formatMegabytes(maxFileSize)}).`,
            };
        case 'LIMIT_FILE_COUNT':
        case 'LIMIT_UNEXPECTED_FILE':
            return { status: 413, message: 'Too many files in a single request.' };
        case 'LIMIT_PART_COUNT':
            return { status: 413, message: 'Too many parts in the upload form.' };
        case 'LIMIT_FIELD_KEY':
            return { status: 400, message: 'Form field name is too long.' };
        case 'LIMIT_FIELD_VALUE':
            return { status: 413, message: 'A form field value exceeds the allowed size.' };
        case 'LIMIT_FIELD_COUNT':
            return { status: 413, message: 'Too many form fields.' };
        default:
            return { status: 400, message: error.message || 'Upload failed.' };
    }
}

function formatMegabytes(bytes: number): string {
    return ByteSize.format(bytes, {unit: 'MB', decimals: 1, integerWithoutDecimals: true});
}

/** Send a multer rejection as a JSON API error (once - a sent response is left alone). */
function respondWithMulterError(response: express.Response, error: MulterError, maxFileSize?: number): void {
    const mapped: { status: number; message: string } = mapMulterError(error, maxFileSize);
    if (!response.headersSent) {
        response.setHeader('Cache-Control', 'private, no-store');
        response.status(mapped.status).json({
            status: { success: false, code: 1 },
            data: null,
            errors: [{ message: mapped.message, details: error.code }],
        });
    }
}

/**
 * Multi-file upload decorator. Accepts an array of files sent under a single
 * form field name (use `formData.append(fieldName, file)` multiple times on the
 * client). `maxCount` caps the number of files accepted in one request.
 *
 * Unlike `Upload` (which uses multer.single), this populates `request.files`
 * with `Express.Multer.File[]`. Limits are enforced both per-file (fileSize)
 * and at the request level (parts, fields, fieldSize) to bound memory usage of
 * the in-memory storage engine and mitigate abusive payloads.
 *
 * Multer rejections (oversized file, too many files, ...) are converted into a
 * JSON error response `{ status: { success:false, code:1 }, errors:[...] }`
 * with an appropriate HTTP code (400/413) so API clients can parse them.
 */
export function UploadArray(fieldName: string = 'files', maxCount: number = 20): MethodDecorator {
    return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        const arrayUpload: Multer = multer({
            storage: storageEngine,
            limits: {
                fileSize: ARRAY_MAX_FILE_SIZE_BYTES,
                // Bound the rest of the multipart payload so memoryStorage cannot be
                // abused via huge text fields or a flood of tiny parts.
                parts: maxCount + 20,
                fields: 1000,
                fieldSize: 1 * 1024 * 1024,
            },
        });

        descriptor.value = async function(request: express.Request, response: express.Response, next: express.NextFunction): Promise<void> {

            await new Promise<void>((resolve, reject) => {
                arrayUpload.array(fieldName, maxCount)(request, response, (error: unknown): void => {
                    if (error) {
                        // Convert multer errors into a JSON API response directly so the
                        // client receives a parseable body instead of a text 500.
                        if (error instanceof MulterError) {
                            respondWithMulterError(response, error, ARRAY_MAX_FILE_SIZE_BYTES);
                            return resolve();
                        }

                        return reject(error);
                    }

                    resolve();
                });
            });

            // If the middleware already responded (e.g. multer rejected the request),
            // do not invoke the controller - it would try to send a second response.
            if (response.headersSent || response.writableEnded) {
                return;
            }

            return originalMethod.call(this, request, response, next);
        };

        return descriptor;
    };
}
