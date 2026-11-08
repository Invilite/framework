import SeaweedService from '../../services/SeaweedService';
import {Env} from '../../utils/Env';
import {StorageStat} from '../../types/interfaces/Storage';
import SeaweedStorage, {StorageStream} from './SeaweedStorage';

export default class LazySeaweedStorage {
    private delegate: SeaweedStorage | null = null;

    public constructor(private readonly collection: string) {
    }

    public async put(key: string, buffer: Buffer, contentType: string = 'image/jpeg'): Promise<void> {
        await this.storage().put(key, buffer, {contentType});
    }

    public async stream(key: string): Promise<StorageStream> {
        return this.storage().getWithInfo(key);
    }

    public async stat(key: string): Promise<StorageStat | null> {
        return this.storage().stat(key);
    }

    public async delete(key: string): Promise<void> {
        await this.storage().delete(key);
    }

    private storage(): SeaweedStorage {
        if (this.delegate === null) {
            this.delegate = new SeaweedStorage(
                new SeaweedService(Env.requireString('SEAWEED_HOST'), Env.requireString('SEAWEED_SECRET')),
                this.collection,
                Env.getString('SEAWEED_REPL', '010'),
                null,
            );
        }
        return this.delegate;
    }
}
