import Storage, {PutOptions, ReadRange, StorageStat} from "../../types/interfaces/Storage";
import {Readable} from "stream";

export default abstract class AbstractStorage implements Storage {

    public abstract put(key: string, content: Buffer | Readable, options?: PutOptions): Promise<void>;
    public abstract get(key: string, range?: ReadRange): Promise<Readable>;
    public abstract delete(key: string): Promise<void>;
    public abstract stat(key: string): Promise<StorageStat | null>;
    public abstract readUrl(key: string): Promise<string>;

    /**
     * Infer a MIME type from the key's extension. Falls back to
     * application/octet-stream for unknown extensions. Public so the HTTP
     * boundary can fall back to it when a backend's stat does not carry
     * a content-type.
     */
    public static inferContentType(key: string): string {
        const lastSlash: number = key.lastIndexOf('/');
        const filename: string = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
        const ext: string = filename.split('.').pop()?.toLowerCase() || '';
        const map: Record<string, string> = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            gif: 'image/gif',
            webp: 'image/webp',
            svg: 'image/svg+xml',
            pdf: 'application/pdf',
            mp4: 'video/mp4',
            webm: 'video/webm',
            avi: 'video/x-msvideo',
            mov: 'video/quicktime',
            mkv: 'video/x-matroska',
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            flac: 'audio/flac',
            m4a: 'audio/mp4',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt: 'application/vnd.ms-powerpoint',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            txt: 'text/plain',
            csv: 'text/csv',
            html: 'text/html',
            zip: 'application/zip',
            json: 'application/json',
            xml: 'application/xml',
        };
        return map[ext] || 'application/octet-stream';
    }

    protected static joinUrl(base: string, key: string): string {
        const normalizedBase: string = base.endsWith('/') ? base.slice(0, -1) : base;
        const normalizedKey: string = key.startsWith('/') ? key : `/${key}`;
        return `${normalizedBase}${normalizedKey}`;
    }
}