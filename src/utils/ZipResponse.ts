import express from 'express';
import path from 'path';
import {Readable} from 'stream';
import {ExtendedRequest} from '../models/ExtendedRequest';
import {ZipStoreWriter} from './ZipStoreWriter';

export interface ZipResponseEntry {
    name: string;
    modified: Date | null;
    /** Źródło pliku otwierane dopiero przy zapisie; `null` = pliku już nie ma, pozycja jest pomijana. */
    open: () => Promise<Readable | null>;
}

/**
 * Wysyła archiwum ZIP składane w locie z plików otwieranych po kolei (`ZipStoreWriter`). Długości
 * nie znamy z góry, więc odpowiedź idzie bez `Content-Length`. Błąd w trakcie zrywa połączenie -
 * przeglądarka pokaże nieudane pobieranie zamiast uciętego archiwum.
 */
export class ZipResponse {
    private static readonly RESERVED_NAME: RegExp = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

    public static async send(
        request: ExtendedRequest,
        response: express.Response,
        fileName: string,
        entries: ZipResponseEntry[],
    ): Promise<void> {
        response.setHeader('Content-Type', 'application/zip');
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${ZipResponse.encode(fileName)}`);
        response.status(200);
        request.selfResponding = true;

        const writer: ZipStoreWriter = new ZipStoreWriter(response);
        const usedNames: Set<string> = new Set<string>();
        let source: Readable | null = null;
        try {
            for (const entry of entries) {
                if (response.destroyed) {
                    return;
                }
                source = await entry.open();
                if (source === null) {
                    continue;
                }
                await writer.addFile(ZipResponse.uniqueName(entry.name, usedNames), source, entry.modified ?? new Date());
                source = null;
            }
            await writer.finish();
            response.end();
        } catch (error: unknown) {
            source?.destroy();
            if (!response.destroyed) {
                request.logger?.error(`ZIP archive ${fileName} failed:`, error);
                response.destroy();
            }
        }
    }

    /**
     * Nazwa bez katalogów i bezpieczna przy rozpakowaniu także w Windows (bez `:*?"<>|`, `.`/`..` i nazw
     * urządzeń jak `CON`), unikalna bez względu na wielkość liter („a.jpg”, „a (2).jpg”).
     */
    public static uniqueName(raw: string, usedNames: Set<string>): string {
        const printable: string = Array.from(raw)
            .filter((char: string): boolean => char.charCodeAt(0) >= 0x20)
            .join('');
        const cleaned: string = path.basename(printable.replace(/\\/g, '/'))
            .replace(/[:*?"<>|]/g, '_')
            .replace(/[. ]+$/, '')
            .trim();
        const base: string = cleaned === '' || /^\.+$/.test(cleaned) ? 'plik' : cleaned;
        const extension: string = path.extname(base);
        const rawStem: string = extension === '' ? base : base.slice(0, -extension.length);
        const stem: string = ZipResponse.RESERVED_NAME.test(rawStem) ? `_${rawStem}` : rawStem;
        let candidate: string = `${stem}${extension}`;
        for (let copy: number = 2; usedNames.has(candidate.toLowerCase()); copy++) {
            candidate = `${stem} (${copy})${extension}`;
        }
        usedNames.add(candidate.toLowerCase());
        return candidate;
    }

    private static encode(name: string): string {
        return encodeURIComponent(name)
            .replace(/['()*]/g, (char: string): string => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    }
}

export default ZipResponse;
