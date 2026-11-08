export type ByteSizeUnit = 'B' | 'KB' | 'MB';

export interface ByteSizeOptions {
    /** Digits after the decimal separator for KB/MB (default 1). */
    decimals?: number;
    /** Force one unit instead of auto-selecting B/KB/MB. */
    unit?: ByteSizeUnit;
    /** Print whole numbers without decimals (Upload-style "50 MB", "1.5 MB"). */
    integerWithoutDecimals?: boolean;
}

/** Human-readable byte sizes (B/KB/MB, binary divisors) with per-call-site formatting options. */
export class ByteSize {
    public static format(bytes: number, options: ByteSizeOptions = {}): string {
        const unit: ByteSizeUnit = options.unit ?? (bytes < 1024 ? 'B' : bytes < 1024 * 1024 ? 'KB' : 'MB');

        if (unit === 'B') {
            return `${bytes} B`;
        }

        const value: number = bytes / (unit === 'KB' ? 1024 : 1024 * 1024);
        const decimals: number = options.decimals ?? 1;
        const text: string = options.integerWithoutDecimals && Number.isInteger(value)
            ? String(value)
            : value.toFixed(decimals);

        return `${text} ${unit}`;
    }
}
