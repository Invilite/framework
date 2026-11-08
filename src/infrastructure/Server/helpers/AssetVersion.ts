import {Path} from "../../../utils/Path";
import fs from "fs";
import crypto from "crypto";

export default class AssetVersion {
    protected readonly cache: Map<string, string>;

    public constructor(private readonly baseDirectory: string) {
        this.cache = new Map();
    }

    public getHelper(): (assetPath: string) => void {
        return this.getAssetVersion.bind(this);
    }

    public getAssetVersion(assetPath: string): string {
        const version: string | undefined = this.cache.get(assetPath);
        if (version) {
            return version;
        }

        const path: string = Path.resolve(this.baseDirectory, assetPath.startsWith('/') ? assetPath.slice(1) : assetPath);
        const content: NonSharedBuffer = fs.readFileSync(path);
        const hash: string = crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);

        this.cache.set(assetPath, hash);

        return hash;
    }
}
