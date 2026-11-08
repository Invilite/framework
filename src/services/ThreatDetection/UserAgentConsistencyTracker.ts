import {HttpThreatText, MAX_HEADER_TEXT_LENGTH} from './HttpThreatText';
import {isAutomationUserAgent, isBrowserUserAgent} from './UserAgentClassifier';

interface RememberedUserAgent {
    userAgent: string;
    seenAt: number;
}

export const USER_AGENT_MEMORY_WINDOW_MS: number = 60_000;
export const USER_AGENT_MEMORY_MAX_ADDRESSES: number = 10_000;

const IPV6_GROUP_COUNT: number = 8;
const IPV6_NETWORK_GROUP_COUNT: number = 4;
const IPV6_MAPPED_GROUP_INDEX: number = 5;
const IPV6_MAPPED_PREFIX: number = 0xffff;

export class UserAgentConsistencyTracker {
    private readonly now: () => number;
    private readonly windowMs: number;
    private readonly maxAddresses: number;
    private readonly remembered: Map<string, RememberedUserAgent> = new Map<string, RememberedUserAgent>();

    public constructor(
        now: () => number = Date.now,
        windowMs: number = USER_AGENT_MEMORY_WINDOW_MS,
        maxAddresses: number = USER_AGENT_MEMORY_MAX_ADDRESSES,
    ) {
        this.now = now;
        this.windowMs = windowMs;
        this.maxAddresses = maxAddresses;
    }

    public observe(clientAddress: string, userAgent: string): string | null {
        const currentUserAgent: string = HttpThreatText.truncate(userAgent, MAX_HEADER_TEXT_LENGTH);

        if (UserAgentConsistencyTracker.isAutomation(currentUserAgent)) {
            const remembered: RememberedUserAgent | undefined = this.remembered.get(
                UserAgentConsistencyTracker.addressKey(clientAddress),
            );

            if (remembered === undefined || this.now() - remembered.seenAt > this.windowMs) {
                return null;
            }

            return remembered.userAgent;
        }

        if (UserAgentConsistencyTracker.isBrowser(currentUserAgent) === false) {
            return null;
        }

        const key: string = HttpThreatText.detach(UserAgentConsistencyTracker.addressKey(clientAddress));
        this.remembered.delete(key);
        this.remembered.set(key, {
            userAgent: HttpThreatText.detach(currentUserAgent),
            seenAt: this.now(),
        });

        if (this.remembered.size > this.maxAddresses) {
            for (const oldestKey of this.remembered.keys()) {
                this.remembered.delete(oldestKey);
                break;
            }
        }

        return null;
    }

    public static addressKey(clientAddress: string): string {
        const normalized: string = clientAddress.trim().toLowerCase();
        const bracketed: boolean = normalized.startsWith('[') && normalized.endsWith(']');
        const unBracketed: string = bracketed ? normalized.slice(1, -1) : normalized;
        const zoneIndex: number = unBracketed.indexOf('%');
        const address: string = zoneIndex === -1 ? unBracketed : unBracketed.slice(0, zoneIndex);

        if (address.includes(':') === false) {
            return address;
        }

        const groups: number[] | null = UserAgentConsistencyTracker.parseIpv6Groups(address);

        if (groups === null) {
            return address;
        }

        if (UserAgentConsistencyTracker.isIpv4Mapped(groups)) {
            return UserAgentConsistencyTracker.ipv4FromGroups(groups);
        }

        return groups
            .slice(0, IPV6_NETWORK_GROUP_COUNT)
            .map((group: number): string => group.toString(16))
            .join(':');
    }

    public static isAutomation(userAgent: string): boolean {
        return isAutomationUserAgent(userAgent);
    }

    public static isBrowser(userAgent: string): boolean {
        return isBrowserUserAgent(userAgent);
    }

    private static parseIpv6Groups(address: string): number[] | null {
        const compressionIndex: number = address.indexOf('::');

        if (compressionIndex !== -1 && address.indexOf('::', compressionIndex + 1) !== -1) {
            return null;
        }

        const leftParts: string[] = compressionIndex === -1
            ? address.split(':')
            : UserAgentConsistencyTracker.nonEmptyGroups(address.slice(0, compressionIndex));
        const rightParts: string[] = compressionIndex === -1
            ? []
            : UserAgentConsistencyTracker.nonEmptyGroups(address.slice(compressionIndex + 2));
        const leftGroups: number[] | null = UserAgentConsistencyTracker.parseGroups(
            leftParts,
            rightParts.length === 0,
        );
        const rightGroups: number[] | null = UserAgentConsistencyTracker.parseGroups(rightParts, true);

        if (leftGroups === null || rightGroups === null) {
            return null;
        }

        if (compressionIndex === -1) {
            return leftGroups.length === IPV6_GROUP_COUNT ? leftGroups : null;
        }

        const missingGroups: number = IPV6_GROUP_COUNT - leftGroups.length - rightGroups.length;

        if (missingGroups < 1) {
            return null;
        }

        return [
            ...leftGroups,
            ...new Array<number>(missingGroups).fill(0),
            ...rightGroups,
        ];
    }

    private static parseGroups(parts: string[], ipv4Allowed: boolean): number[] | null {
        const groups: number[] = [];

        for (let index: number = 0; index < parts.length; index++) {
            const part: string = parts[index];

            if (part.includes('.')) {
                if (ipv4Allowed === false || index !== parts.length - 1) {
                    return null;
                }

                const ipv4Groups: number[] | null = UserAgentConsistencyTracker.parseIpv4(part);

                if (ipv4Groups === null) {
                    return null;
                }

                groups.push(...ipv4Groups);
                continue;
            }

            if (/^[0-9a-f]{1,4}$/.test(part) === false) {
                return null;
            }

            groups.push(parseInt(part, 16));
        }

        return groups;
    }

    private static parseIpv4(address: string): number[] | null {
        const octets: string[] = address.split('.');

        if (octets.length !== 4) {
            return null;
        }

        const numbers: number[] = [];

        for (const octet of octets) {
            if (/^\d{1,3}$/.test(octet) === false) {
                return null;
            }

            const number: number = Number(octet);

            if (number > 255) {
                return null;
            }

            numbers.push(number);
        }

        return [(numbers[0] << 8) | numbers[1], (numbers[2] << 8) | numbers[3]];
    }

    private static isIpv4Mapped(groups: number[]): boolean {
        return groups.length === IPV6_GROUP_COUNT
            && groups[0] === 0
            && groups[1] === 0
            && groups[2] === 0
            && groups[3] === 0
            && groups[4] === 0
            && groups[IPV6_MAPPED_GROUP_INDEX] === IPV6_MAPPED_PREFIX;
    }

    private static ipv4FromGroups(groups: number[]): string {
        return [
            (groups[6] >> 8) & 0xff,
            groups[6] & 0xff,
            (groups[7] >> 8) & 0xff,
            groups[7] & 0xff,
        ].join('.');
    }

    private static nonEmptyGroups(groups: string): string[] {
        return groups.split(':').filter((group: string): boolean => group !== '');
    }
}

export default UserAgentConsistencyTracker;
