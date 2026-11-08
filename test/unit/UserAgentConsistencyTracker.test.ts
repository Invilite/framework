import {
    HEADLESS_CHROME_USER_AGENT,
    IPHONE_SAFARI_USER_AGENT,
} from './fixtures/http-threat-requests';
import {
    UserAgentConsistencyTracker,
} from '../../src/services/ThreatDetection/UserAgentConsistencyTracker';
import {MAX_HEADER_TEXT_LENGTH} from '../../src/services/ThreatDetection/HttpThreatText';

const BINGBOT_USER_AGENT: string = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';

describe('UserAgentConsistencyTracker', () => {
    let now: number;
    let tracker: UserAgentConsistencyTracker;

    const clock = (): number => now;

    beforeEach((): void => {
        now = 1_000_000;
        tracker = new UserAgentConsistencyTracker(clock);
    });

    it('scenariusz z logu daje wcześniejszą przeglądarkę', (): void => {
        expect(tracker.observe('203.0.113.9', IPHONE_SAFARI_USER_AGENT)).toBeNull();

        now += 1_000;

        expect(tracker.observe('203.0.113.9', HEADLESS_CHROME_USER_AGENT)).toBe(IPHONE_SAFARI_USER_AGENT);
    });

    it('sam automat bez przeglądarki nie daje trafienia', (): void => {
        expect(tracker.observe('203.0.113.187', HEADLESS_CHROME_USER_AGENT)).toBeNull();
        expect(tracker.observe('203.0.113.187', HEADLESS_CHROME_USER_AGENT)).toBeNull();
    });

    it('robot przed automatem nie daje trafienia', (): void => {
        expect(tracker.observe('203.0.113.187', BINGBOT_USER_AGENT)).toBeNull();

        now += 1_000;

        expect(tracker.observe('203.0.113.187', HEADLESS_CHROME_USER_AGENT)).toBeNull();
    });

    it('odczyt jest ważny dokładnie przez okno', (): void => {
        tracker.observe('203.0.113.9', IPHONE_SAFARI_USER_AGENT);
        now += 60_000;

        expect(tracker.observe('203.0.113.9', HEADLESS_CHROME_USER_AGENT)).toBe(IPHONE_SAFARI_USER_AGENT);
    });

    it('odczyt po oknie nie daje trafienia', (): void => {
        tracker.observe('203.0.113.9', IPHONE_SAFARI_USER_AGENT);
        now += 60_001;

        expect(tracker.observe('203.0.113.9', HEADLESS_CHROME_USER_AGENT)).toBeNull();
    });

    it('inny adres nie dziedziczy przeglądarki', (): void => {
        tracker.observe('1.2.3.4', IPHONE_SAFARI_USER_AGENT);
        now += 1_000;

        expect(tracker.observe('1.2.3.5', HEADLESS_CHROME_USER_AGENT)).toBeNull();
    });

    it('IPv6 porównuje adresy po sieci /64', (): void => {
        tracker.observe('2a02:a31a:1:2:aaaa::1', IPHONE_SAFARI_USER_AGENT);
        now += 1_000;

        expect(tracker.observe('2a02:a31a:1:2:bbbb::9', HEADLESS_CHROME_USER_AGENT)).toBe(
            IPHONE_SAFARI_USER_AGENT,
        );
    });

    it('addressKey sprowadza IPv6 do pierwszych czterech grup, a IPv4 zostawia bez zmian', (): void => {
        expect(UserAgentConsistencyTracker.addressKey('2001:db8::1')).toBe('2001:db8:0:0');
        expect(UserAgentConsistencyTracker.addressKey('2a02:a31a:1:2:aaaa::1')).toBe('2a02:a31a:1:2');
        expect(UserAgentConsistencyTracker.addressKey('203.0.113.9')).toBe('203.0.113.9');
    });

    it('addressKey kanonizuje zapis IPv6, więc ten sam /64 daje ten sam klucz', (): void => {
        expect(UserAgentConsistencyTracker.addressKey('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(
            UserAgentConsistencyTracker.addressKey('2001:db8::1'),
        );
        expect(UserAgentConsistencyTracker.addressKey('2001:db8::1')).toBe('2001:db8:0:0');
    });

    it('addressKey sprowadza IPv4-mapped IPv6 do osadzonego IPv4', (): void => {
        expect(UserAgentConsistencyTracker.addressKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
        expect(UserAgentConsistencyTracker.addressKey('0:0:0:0:0:ffff:1.2.3.4')).toBe('1.2.3.4');
    });

    it('addressKey zdejmuje nawiasy i strefę adresu', (): void => {
        expect(UserAgentConsistencyTracker.addressKey('[2001:db8::1]')).toBe('2001:db8:0:0');
        expect(UserAgentConsistencyTracker.addressKey('fe80::1%eth0')).toBe('fe80:0:0:0');
        expect(UserAgentConsistencyTracker.addressKey('[fe80::1%eth0]')).toBe('fe80:0:0:0');
    });

    it('addressKey normalizuje IPv4 i nieparsowalny adres', (): void => {
        expect(UserAgentConsistencyTracker.addressKey(' 1.2.3.4')).toBe('1.2.3.4');
        expect(UserAgentConsistencyTracker.addressKey('GARBAGE')).toBe('garbage');
    });

    it('addressKey zwraca nieparsowalny adres małymi literami bez wyjątku', (): void => {
        expect(UserAgentConsistencyTracker.addressKey('2001:DB8:::1')).toBe('2001:db8:::1');
    });

    it('IPv4-mapped różne adresy nie dzielą pamięci', (): void => {
        tracker.observe('::ffff:1.2.3.4', IPHONE_SAFARI_USER_AGENT);
        now += 1_000;

        expect(tracker.observe('::ffff:5.6.7.8', HEADLESS_CHROME_USER_AGENT)).toBeNull();
    });

    it('pełny zapis IPv6 trafia w ten sam /64 co forma skrócona', (): void => {
        tracker.observe('2001:0db8:0000:0000:0000:0000:0000:0001', IPHONE_SAFARI_USER_AGENT);
        now += 1_000;

        expect(tracker.observe('2001:db8::abcd', HEADLESS_CHROME_USER_AGENT)).toBe(IPHONE_SAFARI_USER_AGENT);
    });

    it('przechowuje User-Agent ucięty do 512 znaków', (): void => {
        const longUserAgent: string = 'Mozilla/5.0 ' + 'a'.repeat(14_000);
        tracker.observe('1.2.3.4', longUserAgent);
        now += 1_000;

        const claimedUserAgent: string | null = tracker.observe('1.2.3.4', HEADLESS_CHROME_USER_AGENT);

        expect(claimedUserAgent).toHaveLength(MAX_HEADER_TEXT_LENGTH);
        expect(claimedUserAgent).toBe(longUserAgent.slice(0, MAX_HEADER_TEXT_LENGTH));
    });

    it('limit pamięci usuwa najstarszy adres', (): void => {
        tracker = new UserAgentConsistencyTracker(clock, 60_000, 3);

        for (const address of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
            now += 1_000;
            tracker.observe(address, IPHONE_SAFARI_USER_AGENT);
        }

        expect(tracker.observe('10.0.0.1', HEADLESS_CHROME_USER_AGENT)).toBeNull();
        expect(tracker.observe('10.0.0.4', HEADLESS_CHROME_USER_AGENT)).toBe(IPHONE_SAFARI_USER_AGENT);
    });
});
