import {BlockList} from 'net';

const IPV4_MAPPED_PREFIX: string = '::ffff:';

const INTERNAL_NETWORKS: BlockList = new BlockList();

INTERNAL_NETWORKS.addSubnet('127.0.0.0', 8, 'ipv4');
INTERNAL_NETWORKS.addSubnet('10.0.0.0', 8, 'ipv4');
INTERNAL_NETWORKS.addSubnet('172.16.0.0', 12, 'ipv4');
INTERNAL_NETWORKS.addSubnet('192.168.0.0', 16, 'ipv4');
INTERNAL_NETWORKS.addSubnet('169.254.0.0', 16, 'ipv4');
INTERNAL_NETWORKS.addSubnet('100.64.0.0', 10, 'ipv4');
INTERNAL_NETWORKS.addSubnet('::1', 128, 'ipv6');
INTERNAL_NETWORKS.addSubnet('fc00::', 7, 'ipv6');
INTERNAL_NETWORKS.addSubnet('fe80::', 10, 'ipv6');

export class InternalAddress {
    public static isInternal(address: string): boolean {
        const normalized: string = InternalAddress.normalize(address);

        if (normalized === '') {
            return false;
        }

        const mappedIpv4: string | null = InternalAddress.ipv4FromMapped(normalized);

        if (mappedIpv4 !== null) {
            return InternalAddress.check(mappedIpv4, 'ipv4');
        }

        return InternalAddress.check(normalized, normalized.includes(':') ? 'ipv6' : 'ipv4');
    }

    private static check(address: string, family: 'ipv4' | 'ipv6'): boolean {
        try {
            return INTERNAL_NETWORKS.check(address, family);
        } catch {
            return false;
        }
    }

    private static normalize(address: string): string {
        const trimmed: string = address.trim().toLowerCase();
        const bracketed: boolean = trimmed.startsWith('[') && trimmed.endsWith(']');

        if (bracketed) {
            return InternalAddress.withoutZone(trimmed.slice(1, -1));
        }

        if (trimmed.startsWith('[') || trimmed.endsWith(']')) {
            return '';
        }

        return InternalAddress.withoutZone(trimmed);
    }

    private static withoutZone(address: string): string {
        const zoneIndex: number = address.indexOf('%');

        return zoneIndex === -1 ? address : address.slice(0, zoneIndex);
    }

    private static ipv4FromMapped(address: string): string | null {
        if (address.startsWith(IPV4_MAPPED_PREFIX) === false) {
            return null;
        }

        const candidate: string = address.slice(IPV4_MAPPED_PREFIX.length);

        return candidate.includes('.') ? candidate : null;
    }
}

export default InternalAddress;
