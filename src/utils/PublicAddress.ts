import {BlockList, isIP} from 'net';

const NON_PUBLIC_NETWORKS: BlockList = new BlockList();

const IPV4_NON_PUBLIC: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];

/**
 * IPv6 ranges that are not globally routable or that embed an IPv4 address the IPv4 rules above
 * would not see (IPv4-compatible ::/96, NAT64, 6to4, Teredo). IPv4-mapped ::ffff:0:0/96 needs no
 * entry: BlockList checks a mapped address against the IPv4 rules in any notation, hex included.
 */
const IPV6_NON_PUBLIC: Array<[string, number]> = [
    ['::', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
];

for (const [network, prefix] of IPV4_NON_PUBLIC) {
    NON_PUBLIC_NETWORKS.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of IPV6_NON_PUBLIC) {
    NON_PUBLIC_NETWORKS.addSubnet(network, prefix, 'ipv6');
}

/**
 * Whether an address is a public unicast one that a server may connect to on a user's behalf
 * (SSRF guard). Anything that is not a literal IP address, including bracketed or zoned forms,
 * counts as not public, so callers resolve host names first and check every resolved address.
 */
export class PublicAddress {
    public static isPublic(address: string): boolean {
        const family: number = isIP(address);

        if (family === 0) {
            return false;
        }

        try {
            return NON_PUBLIC_NETWORKS.check(address, family === 4 ? 'ipv4' : 'ipv6') === false;
        } catch {
            return false;
        }
    }
}

export default PublicAddress;
