import sharp, {Metadata} from "sharp";
import exifr from "exifr";
import {NulChar} from "./NulChar";

/**
 * EXIF and image metadata read from an untrusted file. Both readers sanitize their output with
 * NulChar so the result can be stored in PostgreSQL `jsonb` (cameras pad EXIF strings with NUL
 * bytes and broken files can carry lone UTF-16 surrogates).
 */
export class ImageMetadata {

    /**
     * Full EXIF, including GPS and maker notes. Returns null when the file has no readable EXIF.
     */
    public static async readExif(buffer: Buffer): Promise<Record<string, unknown> | null> {
        const parsed: Record<string, unknown> | undefined = await exifr.parse(buffer, {
            tiff: true,
            exif: true,
            gps: true,
            jfif: true,
            ifd1: true,
            interop: true,
            makerNote: true,
            userComment: true,
            xmp: true,
            translateKeys: true,
            translateValues: true,
            reviveValues: true,
            sanitize: true,
            mergeOutput: true,
        });

        return NulChar.strip(parsed) ?? null;
    }

    /**
     * Image metadata as reported by sharp, without the raw EXIF/ICC/IPTC/XMP payloads.
     * Sanitized with NulChar for the same jsonb reasons as readExif.
     */
    public static async readMetadata(buffer: Buffer): Promise<Record<string, unknown>> {
        const metadata: Metadata = await sharp(buffer).metadata();

        delete metadata.exif;
        delete metadata.icc;
        delete metadata.iptc;
        delete metadata.xmpAsString;
        delete metadata.xmp;

        return NulChar.strip(metadata) as unknown as Record<string, unknown>;
    }
}
