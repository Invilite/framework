import {
    HttpThreatText,
    MAX_HEADER_TEXT_LENGTH,
    MAX_URL_TEXT_LENGTH,
} from '../../src/services/ThreatDetection/HttpThreatText';

describe('HttpThreatText', () => {
    it('dekoduje maksymalnie dwa razy', () => {
        expect(HttpThreatText.decode('%252e%252e%252f', false)).toBe('../');
        expect(HttpThreatText.decode('%25252e', false)).toBe('%2e');
    });

    it('plus jako spacja tylko na żądanie', () => {
        expect(HttpThreatText.decode('1+UNION+SELECT', true)).toBe('1 UNION SELECT');
        expect(HttpThreatText.decode('a+b', false)).toBe('a+b');
    });

    it('zakodowany plus zostaje plusem', () => {
        expect(HttpThreatText.decode('a%2Bb', true)).toBe('a+b');
    });

    it('błędne kodowanie', () => {
        expect(HttpThreatText.decode('/%E0%A4%A', false)).toBe('/%E0%A4%A');
        expect(HttpThreatText.decode('100%', true)).toBe('100%');
        expect(HttpThreatText.decode('%25E0', false)).toBe('%E0');
    });

    it('dekoduje mimo błędnej sekwencji', () => {
        expect(HttpThreatText.decode('/%zz/..%252f..%252fetc%252fpasswd', false)).toBe('/%zz/../../etc/passwd');
        expect(HttpThreatText.decode('%E0%A4%A%41', false)).toBe('प');
    });

    it('ucina do limitu', () => {
        expect(HttpThreatText.truncate('a'.repeat(3000), MAX_URL_TEXT_LENGTH).length).toBe(2048);
        expect(HttpThreatText.truncate('krótki tekst', MAX_URL_TEXT_LENGTH)).toBe('krótki tekst');
        expect(HttpThreatText.truncate('a'.repeat(2048), MAX_URL_TEXT_LENGTH)).toBe('a'.repeat(2048));
        expect(HttpThreatText.truncate('b'.repeat(600), MAX_HEADER_TEXT_LENGTH).length).toBe(512);
    });

    it('nie rozcina pary surogatów', () => {
        expect(HttpThreatText.truncate('a'.repeat(2047) + '😀', MAX_URL_TEXT_LENGTH)).toBe('a'.repeat(2047));
    });

    it('kopiuje tekst, by nie trzymać rodzica', () => {
        expect(HttpThreatText.detach('zażółć gęślą jaźń')).toBe('zażółć gęślą jaźń');
        expect(HttpThreatText.detach('a'.repeat(14_000))).toBe('a'.repeat(14_000));
    });

    it('oczyszcza znaki sterujące', () => {
        expect(HttpThreatText.sanitize('a\nb\r\x00\x7f')).toBe('a\\x0ab\\x0d\\x00\\x7f');
        expect(HttpThreatText.sanitize('zażółć')).toBe('zażółć');
    });

    it('oczyszcza znaki sterujące C1 i separatory wiersza', () => {
        expect(HttpThreatText.sanitize('a\u0085b\u009fc')).toBe('a\\x85b\\x9fc');
        expect(HttpThreatText.sanitize('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c');
    });
});
