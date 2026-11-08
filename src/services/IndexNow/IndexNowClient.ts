import axios, {AxiosResponse} from 'axios';
import {AbstractLogger} from '../../types/interfaces/AbstractLogger';

const DEFAULT_ENDPOINT: string = 'https://api.indexnow.org/indexnow';
const DEFAULT_BATCH_DELAY_MS: number = 3_600_000;
const DEFAULT_THROTTLE_MS: number = 3_600_000;
const MAX_URLS_PER_BATCH: number = 10_000;
const REQUEST_TIMEOUT_MS: number = 10_000;

export interface IndexNowClientOptions {
    host: string;
    key: string;
    keyLocation: string;
    endpoint?: string;
    batchDelayMs?: number;
    throttleMs?: number;
}

export class IndexNowClient {
    private readonly host: string;
    private readonly key: string;
    private readonly keyLocation: string;
    private readonly endpoint: string;
    private readonly batchDelayMs: number;
    private readonly throttleMs: number;
    private readonly buffer: Set<string> = new Set<string>();
    private timer: NodeJS.Timeout | null = null;
    private pausedUntil: number = 0;

    public constructor(options: IndexNowClientOptions, private readonly logger: AbstractLogger) {
        this.host = options.host;
        this.key = options.key;
        this.keyLocation = options.keyLocation;
        this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
        this.batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
        this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    }

    public submit(urls: string[]): void {
        let added: boolean = false;
        for (const url of urls) {
            if (!this.belongsToHost(url)) {
                this.logger.warning(`[IndexNow] rejected URL outside host ${this.host}: ${url}`);
                continue;
            }
            this.buffer.add(url);
            added = true;
        }

        if (added && this.timer === null) {
            this.schedule(this.pausedUntil > Date.now() ? this.pausedUntil - Date.now() : this.batchDelayMs);
        }
    }

    public async flush(): Promise<void> {
        this.clearTimer();
        await this.sendBuffer();
    }

    public async stop(): Promise<void> {
        this.clearTimer();
        await this.flush();
        this.clearTimer();
    }

    private belongsToHost(url: string): boolean {
        try {
            const parsed: URL = new URL(url);
            return parsed.protocol === 'https:' && parsed.hostname === this.host;
        } catch {
            return false;
        }
    }

    private schedule(delayMs: number): void {
        this.clearTimer();
        this.timer = setTimeout((): void => {
            this.timer = null;
            void this.sendBuffer();
        }, Math.max(0, delayMs));
        this.timer.unref?.();
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private async sendBuffer(): Promise<void> {
        if (this.buffer.size === 0) {
            return;
        }

        const urls: string[] = Array.from(this.buffer);
        let paused: boolean = false;

        for (let offset: number = 0; offset < urls.length; offset += MAX_URLS_PER_BATCH) {
            const batch: string[] = urls.slice(offset, offset + MAX_URLS_PER_BATCH);
            let response: AxiosResponse;
            try {
                response = await axios.post(this.endpoint, {
                    host: this.host,
                    key: this.key,
                    keyLocation: this.keyLocation,
                    urlList: batch,
                }, {
                    headers: {'Content-Type': 'application/json; charset=utf-8'},
                    timeout: REQUEST_TIMEOUT_MS,
                    validateStatus: (): boolean => true,
                });
            } catch (error: unknown) {
                this.logger.error(`[IndexNow] batch of ${batch.length} URLs failed: ${IndexNowClient.errorMessage(error)}`);
                this.removeBatch(batch);
                continue;
            }

            if (response.status === 200 || response.status === 202) {
                this.logger.info(`[IndexNow] accepted ${batch.length} URLs (HTTP ${response.status})`);
                this.removeBatch(batch);
                continue;
            }

            if (response.status === 429) {
                this.pausedUntil = Date.now() + this.throttleMs;
                this.logger.error(`[IndexNow] rate limited, ${batch.length} URLs kept for retry (HTTP 429)`);
                paused = true;
                break;
            }

            this.logger.error(`[IndexNow] batch of ${batch.length} URLs rejected (HTTP ${response.status})`);
            this.removeBatch(batch);
        }

        if (paused) {
            this.schedule(this.throttleMs);
            return;
        }

        if (this.buffer.size > 0 && this.timer === null) {
            this.schedule(this.batchDelayMs);
        }
    }

    private removeBatch(batch: string[]): void {
        for (const url of batch) {
            this.buffer.delete(url);
        }
    }

    private static errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
