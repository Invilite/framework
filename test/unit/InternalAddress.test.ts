import {InternalAddress} from '../../src/utils/InternalAddress';

describe('InternalAddress', () => {
    it.each([
        '172.28.0.2',
        '10.1.2.3',
        '192.168.0.10',
        '127.0.0.1',
        '169.254.169.254',
        '100.64.0.1',
        '::1',
        '[::1]',
        'fd12:3456::1',
        'fe80::1%eth0',
        '::ffff:10.0.0.1',
    ])('%s jest adresem wewnętrznym', (address: string): void => {
        expect(InternalAddress.isInternal(address)).toBe(true);
    });

    it.each([
        '172.15.0.1',
        '172.32.0.1',
        '8.8.8.8',
        '100.128.0.1',
        '2a02:a31a::1',
        '::ffff:8.8.8.8',
        '',
        'garbage',
        '999.1.1.1',
    ])('%s nie jest adresem wewnętrznym', (address: string): void => {
        expect(InternalAddress.isInternal(address)).toBe(false);
    });
});
