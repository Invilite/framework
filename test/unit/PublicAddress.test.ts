import {PublicAddress} from "../../src/utils/PublicAddress";

describe("PublicAddress.isPublic", () => {
    it.each([
        "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.5", "169.254.169.254", "100.64.0.1",
        "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    ])("odrzuca niepubliczny IPv4 %s", (address: string): void => {
        expect(PublicAddress.isPublic(address)).toBe(false);
    });

    it.each([
        "::1", "0:0:0:0:0:0:0:1", "::", "fe80::1", "fe80::1%eth0", "fd00::1", "ff02::1",
        "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1",
        "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1",
    ])("odrzuca niepubliczny lub osadzający IPv4 IPv6 %s", (address: string): void => {
        expect(PublicAddress.isPublic(address)).toBe(false);
    });

    it.each(["8.8.8.8", "172.15.0.1", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
        "przepuszcza publiczny %s",
        (address: string): void => {
            expect(PublicAddress.isPublic(address)).toBe(true);
        },
    );

    it.each(["", "localhost", "[::1]", "127.1", "example.com"])("nie uznaje za publiczny tekstu, który nie jest IP: %s", (address: string): void => {
        expect(PublicAddress.isPublic(address)).toBe(false);
    });
});
