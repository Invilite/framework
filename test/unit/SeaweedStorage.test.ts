import {Readable} from "stream";
import SeaweedStorage from "../../src/infrastructure/Storage/SeaweedStorage";
import SeaweedService from "../../src/services/SeaweedService";
import StorageError from "../../src/errors/ApplicationError/StorageError";

interface FakeSeaweed {
    upload: jest.Mock;
    deleteIfExists: jest.Mock;
    stat: jest.Mock;
    stream: jest.Mock;
}

function fakeSeaweed(): FakeSeaweed {
    return {
        upload: jest.fn().mockResolvedValue({}),
        deleteIfExists: jest.fn().mockResolvedValue(undefined),
        stat: jest.fn().mockResolvedValue({size: 1234}),
        stream: jest.fn(),
    };
}

function build(seaweed: FakeSeaweed, readHost: string | null = null): SeaweedStorage {
    return new SeaweedStorage(seaweed as unknown as SeaweedService, 'documents', '010', readHost);
}

const KEY: string = 'documents/a1/b2/c3d4/key/large.jpg';

describe('SeaweedStorage', () => {
    it('put przekazuje ścieżkę filera z wiodącym /, stałą kolekcję i replikację oraz contentType', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        await build(seaweed).put(KEY, Buffer.from('bytes'), {contentType: 'image/jpeg'});

        expect(seaweed.upload).toHaveBeenCalledWith(
            Buffer.from('bytes'),
            `/${KEY}`,
            'documents',
            '010',
            {contentType: 'image/jpeg'},
        );
    });

    it('put bez contentType wnioskuje typ z rozszerzenia, a Readable zamienia na bufor', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        await build(seaweed).put(KEY, Readable.from([Buffer.from('ab'), Buffer.from('cd')]));

        expect(seaweed.upload).toHaveBeenCalledWith(
            Buffer.from('abcd'),
            `/${KEY}`,
            'documents',
            '010',
            {contentType: 'image/jpeg'},
        );
    });

    it('get z Range deleguje do stream i zwraca strumień', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        const stream: Readable = Readable.from([Buffer.from('x')]);
        seaweed.stream.mockResolvedValue({stream, size: 10, contentRange: 'bytes 5-14/100'});

        const result: Readable = await build(seaweed).get(KEY, {offset: 5, length: 10});

        expect(result).toBe(stream);
        expect(seaweed.stream).toHaveBeenCalledWith(`/${KEY}`, {offset: 5, length: 10});
    });

    it('getWithInfo zwraca strumień, rozmiar i Content-Range', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        const stream: Readable = Readable.from([Buffer.from('x')]);
        seaweed.stream.mockResolvedValue({stream, size: 10, contentRange: 'bytes 5-14/100'});

        await expect(build(seaweed).getWithInfo(KEY, {offset: 5, length: 10}))
            .resolves.toEqual({stream, size: 10, contentRange: 'bytes 5-14/100'});
    });

    it('brak pliku → StorageError NOT_FOUND', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        seaweed.stream.mockRejectedValue(new StorageError('missing', 'NOT_FOUND'));

        await expect(build(seaweed).get(KEY)).rejects.toMatchObject({
            name: 'StorageError',
            code: 'NOT_FOUND',
        });
    });

    it('delete jest idempotentny (deleteIfExists)', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        await build(seaweed).delete(KEY);

        expect(seaweed.deleteIfExists).toHaveBeenCalledWith(`/${KEY}`);
    });

    it('stat mapuje rozmiar i wnioskuje contentType; brak pliku → null', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        const storage: SeaweedStorage = build(seaweed);

        await expect(storage.stat(KEY)).resolves.toEqual({size: 1234, contentType: 'image/jpeg'});

        seaweed.stat.mockResolvedValue(null);
        await expect(storage.stat(KEY)).resolves.toBeNull();
    });

    it('readUrl bez publicznego hosta → StorageError UNSUPPORTED', async (): Promise<void> => {
        await expect(build(fakeSeaweed(), null).readUrl(KEY)).rejects.toMatchObject({
            name: 'StorageError',
            code: 'UNSUPPORTED',
        });
    });

    it('readUrl z hostem składa poprawny adres bez podwójnego slasha', async (): Promise<void> => {
        await expect(build(fakeSeaweed(), 'https://read.example/').readUrl(KEY))
            .resolves.toBe(`https://read.example/${KEY}`);
    });

    it.each([
        ['pusty', ''],
        ['kropka', 'a/./b'],
        ['dwie kropki', 'a/../b'],
        ['pusty segment', 'a//b'],
        ['pytajnik', 'a?b'],
        ['hash', 'a#b'],
        ['procent', 'a%b'],
        ['backslash', 'a\\b'],
        ['spacja', 'a b'],
        ['nowa linia', 'a\nb'],
        ['NUL', 'a\u0000b'],
        ['cudzysłów', 'a"b'],
    ])('put rejects an invalid key: %s', async (_label: string, key: string): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();

        await expect(build(seaweed).put(key, Buffer.from('x'))).rejects.toMatchObject({
            name: 'StorageError',
            code: 'INVALID_PATH',
        });
        expect(seaweed.upload).not.toHaveBeenCalled();
    });

    it('delete, stat and readUrl reject an invalid key', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        const storage: SeaweedStorage = build(seaweed, 'https://read.example');

        await expect(storage.delete('../escape')).rejects.toMatchObject({code: 'INVALID_PATH'});
        await expect(storage.stat('a?b')).rejects.toMatchObject({code: 'INVALID_PATH'});
        await expect(storage.readUrl('a#b')).rejects.toMatchObject({code: 'INVALID_PATH'});
        expect(seaweed.deleteIfExists).not.toHaveBeenCalled();
        expect(seaweed.stat).not.toHaveBeenCalled();
    });

    it('allows uppercase letters and regular dots in the file name', async (): Promise<void> => {
        const seaweed: FakeSeaweed = fakeSeaweed();
        const key: string = 'Archive/A1/Picture.JPG';

        await build(seaweed).put(key, Buffer.from('x'));

        expect(seaweed.upload).toHaveBeenCalledWith(
            Buffer.from('x'),
            `/${key}`,
            'documents',
            '010',
            {contentType: 'image/jpeg'},
        );
    });
});
