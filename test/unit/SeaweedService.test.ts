import axios from 'axios';
import FormData from 'form-data';
import {Readable} from 'stream';
import {inspect} from 'util';
import SeaweedService from '../../src/services/SeaweedService';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

describe('SeaweedService - additions for the photo storage redesign', () => {
    const seaweed: SeaweedService = new SeaweedService('http://filer:8888', 'secret');

    beforeEach(() => jest.resetAllMocks());

    it('copy wysyła POST na ścieżkę docelową z cp.from', async () => {
        mocked.post.mockResolvedValue({status: 201});
        await seaweed.copy('/images/a1/b2/c3/d4/old.jpg', '/images/a1/b2/c3/d4/new.jpg');
        expect(mocked.post).toHaveBeenCalledWith(
            'http://filer:8888/images/a1/b2/c3/d4/new.jpg?cp.from=%2Fimages%2Fa1%2Fb2%2Fc3%2Fd4%2Fold.jpg',
            null,
            expect.objectContaining({headers: expect.objectContaining({Authorization: expect.stringMatching(/^Bearer /)})}),
        );
    });

    it('stat: rozmiar z Content-Length, 404 = null', async () => {
        mocked.head.mockResolvedValueOnce({status: 200, headers: {'content-length': '1234'}});
        await expect(seaweed.stat('/x.jpg')).resolves.toEqual({size: 1234});
        mocked.head.mockRejectedValueOnce({response: {status: 404}});
        await expect(seaweed.stat('/x.jpg')).resolves.toBeNull();
    });

    it('deleteIfExists połyka 404, inne błędy przepuszcza', async () => {
        mocked.delete.mockRejectedValueOnce({response: {status: 404}});
        await expect(seaweed.deleteIfExists('/x.jpg')).resolves.toBeUndefined();
        mocked.delete.mockRejectedValueOnce({response: {status: 500}});
        await expect(seaweed.deleteIfExists('/x.jpg')).rejects.toEqual({response: {status: 500}});
    });

    it('download zwraca bajty', async () => {
        mocked.get.mockResolvedValue({data: new Uint8Array([1, 2, 3]).buffer});
        await expect(seaweed.download('/x.jpg')).resolves.toEqual(Buffer.from([1, 2, 3]));
    });

    it('stream: responseType stream, rozmiar i Content-Range z nagłówków', async () => {
        const stream = Readable.from([Buffer.from('x')]);
        mocked.get.mockResolvedValue({
            data: stream,
            headers: {'content-length': '10', 'content-range': 'bytes 5-14/100'},
        });

        const result = await seaweed.stream('/x.jpg', {offset: 5, length: 10});

        expect(result).toEqual({stream, size: 10, contentRange: 'bytes 5-14/100'});
        expect(mocked.get).toHaveBeenCalledWith('http://filer:8888/x.jpg', expect.objectContaining({
            responseType: 'stream',
            headers: expect.objectContaining({
                Authorization: expect.stringMatching(/^Bearer /),
                Range: 'bytes=5-14',
            }),
        }));
        const config: any = mocked.get.mock.calls[0][1];
        expect(config.timeout).toBeUndefined();
        expect(config.signal).toBeDefined();
    });

    it('stream bez Range nie wysyła nagłówka Range', async () => {
        mocked.get.mockResolvedValue({data: Readable.from([]), headers: {'content-length': '3'}});

        await expect(seaweed.stream('/x.jpg')).resolves.toMatchObject({size: 3, contentRange: null});
        const config: any = mocked.get.mock.calls[0][1];
        expect(config.headers.Range).toBeUndefined();
    });

    it('stream: brak pliku (404) → StorageError NOT_FOUND', async () => {
        mocked.get.mockRejectedValue({response: {status: 404}});

        await expect(seaweed.stream('/x.jpg')).rejects.toMatchObject({name: 'StorageError', code: 'NOT_FOUND'});
    });
});

describe('SeaweedService - limit czasu żądań (zawieszony filer nie wiesza uploadu ani release)', () => {
    beforeEach(() => jest.resetAllMocks());

    const configOf = (call: any[] | undefined): any => call?.[call.length - 1];

    async function callEverything(seaweed: SeaweedService): Promise<void> {
        mocked.post.mockResolvedValue({status: 201});
        mocked.delete.mockResolvedValue({status: 204});
        mocked.get.mockResolvedValue({data: new Uint8Array([1]).buffer});
        mocked.head.mockResolvedValue({status: 200, headers: {'content-length': '1'}});
        await seaweed.upload(Buffer.from('x'), '/x.jpg');
        await seaweed.delete('/x.jpg');
        await seaweed.deleteIfExists('/x.jpg');
        await seaweed.download('/x.jpg');
        await seaweed.stat('/x.jpg');
        await seaweed.copy('/a.jpg', '/b.jpg');
        await seaweed.getFileMetadata('/x.jpg');
    }

    it('domyślnie każde żądanie ma limit 30 s', async () => {
        await callEverything(new SeaweedService('http://filer:8888', 'secret'));
        const calls: any[][] = [...mocked.post.mock.calls, ...mocked.delete.mock.calls, ...mocked.get.mock.calls, ...mocked.head.mock.calls];
        expect(calls).toHaveLength(7);
        for (const call of calls) {
            expect(configOf(call).timeout).toBe(30_000);
        }
    });

    it('limit z konstruktora trafia do każdego żądania', async () => {
        await callEverything(new SeaweedService('http://filer:8888', 'secret', 5_000));
        const calls: any[][] = [...mocked.post.mock.calls, ...mocked.delete.mock.calls, ...mocked.get.mock.calls, ...mocked.head.mock.calls];
        for (const call of calls) {
            expect(configOf(call).timeout).toBe(5_000);
        }
    });
});


describe('SeaweedService - error sanitization and multipart filename', () => {
    const seaweed: SeaweedService = new SeaweedService('http://filer:8888', 'secret');

    beforeEach(() => {
        jest.resetAllMocks();
        (mocked.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
    });

    function axiosErrorWithSecrets(status: number): Error {
        const error: Error & {isAxiosError: boolean; code: string; config: unknown; response: unknown} =
            new Error(`Request failed with status code ${status}`) as Error & {isAxiosError: boolean; code: string; config: unknown; response: unknown};
        error.isAxiosError = true;
        error.code = 'ERR_BAD_RESPONSE';
        error.config = {
            headers: {Authorization: 'Bearer filer-secret'},
            data: {prompt: 'secret-prompt'},
        };
        error.response = {status, data: {message: 'filer failure'}};
        return error;
    }

    async function rejection(promise: Promise<unknown>): Promise<unknown> {
        try {
            await promise;
        } catch (error: unknown) {
            return error;
        }
        throw new Error('Expected the promise to reject');
    }

    it('does not expose request headers or body when stat rethrows an axios error', async (): Promise<void> => {
        mocked.head.mockRejectedValueOnce(axiosErrorWithSecrets(500));

        const thrown: unknown = await rejection(seaweed.stat('/x.jpg'));
        const serialized: string = JSON.stringify(thrown);
        const inspected: string = inspect(thrown, {depth: null});

        expect(thrown).toBeInstanceOf(Error);
        expect(serialized).not.toContain('filer-secret');
        expect(inspected).not.toContain('filer-secret');
        expect(inspected).not.toContain('secret-prompt');
        expect(serialized).toContain('filer failure');
    });

    it('does not expose request headers or body when upload rethrows an axios error', async (): Promise<void> => {
        mocked.post.mockRejectedValueOnce(axiosErrorWithSecrets(401));

        const thrown: unknown = await rejection(seaweed.upload(Buffer.from('x'), '/x.jpg'));
        const inspected: string = inspect(thrown, {depth: null});

        expect(inspected).not.toContain('filer-secret');
        expect(inspected).not.toContain('secret-prompt');
    });

    it('sanitizes quotes and control characters in the multipart filename', async (): Promise<void> => {
        mocked.post.mockResolvedValue({status: 201});

        await seaweed.upload(Buffer.from('x'), '/x.jpg', undefined, '010', {filename: 'bad"\r\nname.jpg'});

        const form: FormData = mocked.post.mock.calls[0][1] as FormData;
        const body: string = form.getBuffer().toString('utf8');
        expect(body).toContain('filename="bad___name.jpg"');
    });
});
