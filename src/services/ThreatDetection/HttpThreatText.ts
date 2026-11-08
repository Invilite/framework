export const MAX_URL_TEXT_LENGTH: number = 2048;
export const MAX_HEADER_TEXT_LENGTH: number = 512;
export const MAX_CLIENT_ADDRESS_LENGTH: number = 128;

// eslint-disable-next-line no-control-regex -- matching control characters is the sanitizer's purpose
const CONTROL_CHARACTER_PATTERN: RegExp = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const PERCENT_ESCAPE_RUN_PATTERN: RegExp = /(?:%[0-9a-fA-F]{2})+/g;
const MAX_DECODE_ROUNDS: number = 2;

export class HttpThreatText {
    public static decode(text: string, plusAsSpace: boolean): string {
        let current: string = plusAsSpace ? text.replace(/\+/g, ' ') : text;

        for (let round: number = 0; round < MAX_DECODE_ROUNDS; round++) {
            const decoded: string = current.replace(PERCENT_ESCAPE_RUN_PATTERN, (run: string): string => {
                try {
                    return decodeURIComponent(run);
                } catch {
                    return run;
                }
            });

            if (decoded === current) {
                break;
            }

            current = decoded;
        }

        return current;
    }

    public static truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }

        const lastIncludedIndex: number = maxLength - 1;
        const lastCodeUnit: number = text.charCodeAt(lastIncludedIndex);
        const lastIsHighSurrogate: boolean = lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF;
        const cutIndex: number = lastIsHighSurrogate ? lastIncludedIndex : maxLength;

        return text.slice(0, cutIndex);
    }

    public static detach(text: string): string {
        return Buffer.from(text, 'utf8').toString('utf8');
    }

    public static sanitize(text: string): string {
        return text.replace(CONTROL_CHARACTER_PATTERN, (character: string): string => {
            const code: number = character.charCodeAt(0);

            if (code <= 0xff) {
                return '\\x' + code.toString(16).padStart(2, '0');
            }

            return '\\u' + code.toString(16).padStart(4, '0');
        });
    }
}
