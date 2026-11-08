/**
 * Minimal structural subset of sharp.Sharp used here. The consumer injects
 * its own sharp (consumers pin different versions; an import here would
 * resolve a different libvips in tests than in production and could produce
 * different hashes).
 */
export interface SharpLike {
    metadata(): Promise<{width?: number; height?: number}>;
    removeAlpha(): SharpLike;
    greyscale(): SharpLike;
    toColourspace(colourspace: string): SharpLike;
    resize(width: number, height: number, options: {fit: 'fill'; fastShrinkOnLoad: boolean}): SharpLike;
    raw(): SharpLike;
    toBuffer(options: {resolveWithObject: true}): Promise<{data: Buffer; info: {channels: number}}>;
}

export type SharpFactory = (input: Buffer) => SharpLike;

/**
 * Perceptual signature of an image: a 256-bit gradient hash as a '0'/'1'
 * string (Postgres bit(256) text form) and the width/height ratio.
 */
export interface ImageSignature {
    hash: string;
    aspect: number;
}

/** Pixel difference of two 32x32 RGB renderings, in 0-255 channel units. */
export interface PixelDiff {
    meanDiff: number;
    worstBlock: number;
}

export interface DuplicateThresholds {
    // Fast stage: max Hamming distance of two hashes to be a candidate.
    maxCandidateDistance: number;
    // Exact stage: all three must hold.
    maxMeanDiff: number;
    maxWorstBlock: number;
    maxAspectLogRatio: number;
}

export const SIGNATURE_BITS: number = 256;

// Measured on 400 px thumbnails: 55 duplicate pairs vs 17 same-series pairs.
export const DEFAULT_DUPLICATE_THRESHOLDS: DuplicateThresholds = Object.freeze({
    maxCandidateDistance: 24,
    maxMeanDiff: 2,
    maxWorstBlock: 6,
    maxAspectLogRatio: 0.02,
});

const HASH_WIDTH: number = 17;
const HASH_HEIGHT: number = 16;
const PIXELS_EDGE: number = 32;
const PIXELS_CHANNELS: number = 3;
const BLOCK_EDGE: number = 4;
const PIXELS_LENGTH: number = PIXELS_EDGE * PIXELS_EDGE * PIXELS_CHANNELS;

export function hammingDistance(first: string, second: string): number {
    if (first.length !== second.length) {
        throw new Error(`Hash length mismatch: ${first.length} vs ${second.length}`);
    }
    let distance: number = 0;
    for (let i: number = 0; i < first.length; i++) {
        if (first[i] !== second[i]) {
            distance += 1;
        }
    }
    return distance;
}

/**
 * Near-duplicate image detection primitives: a gradient hash for a cheap
 * candidate search and a 32x32 pixel comparison for the exact verdict.
 * Input is expected to be already oriented (e.g. an EXIF-rotated
 * thumbnail). fastShrinkOnLoad is disabled on every resize - libjpeg's
 * shrink-on-load would make a JPEG and a PNG of the same picture differ by
 * more than the thresholds.
 */
export default class ImageSignatureService {
    public readonly thresholds: DuplicateThresholds;
    private readonly sharp: SharpFactory;

    public constructor(sharpFactory: SharpFactory, thresholds: DuplicateThresholds = DEFAULT_DUPLICATE_THRESHOLDS) {
        this.sharp = sharpFactory;
        this.thresholds = thresholds;
    }

    public async signatureFromImage(buffer: Buffer): Promise<ImageSignature> {
        const metadata: { width?: number; height?: number; } = await this.sharp(buffer).metadata();
        if (!metadata.width || !metadata.height) {
            throw new Error('Image has no dimensions');
        }

        const {data, info}: { data: Buffer; info: { channels: number; }; } = await this.sharp(buffer)
            .removeAlpha()
            .greyscale()
            .resize(HASH_WIDTH, HASH_HEIGHT, {fit: 'fill', fastShrinkOnLoad: false})
            .raw()
            .toBuffer({resolveWithObject: true});

        let hash: string = '';
        for (let y: number = 0; y < HASH_HEIGHT; y++) {
            for (let x: number = 0; x < HASH_WIDTH - 1; x++) {
                const index: number = (y * HASH_WIDTH + x) * info.channels;
                hash += data[index] > data[index + info.channels] ? '1' : '0';
            }
        }

        return {hash, aspect: metadata.width / metadata.height};
    }

    /** 32x32 RGB, row-major, 3072 bytes - the exact-stage comparison input. */
    public async pixels32(buffer: Buffer): Promise<Buffer> {
        const {data}: { data: Buffer; info: { channels: number; }; } = await this.sharp(buffer)
            .removeAlpha()
            .toColourspace('srgb')
            .resize(PIXELS_EDGE, PIXELS_EDGE, {fit: 'fill', fastShrinkOnLoad: false})
            .raw()
            .toBuffer({resolveWithObject: true});
        return data;
    }

    /**
     * Mean absolute channel difference over the whole image, and the worst
     * mean over the 8x8 grid of 4x4-pixel blocks (catches a local change the
     * global mean would dilute).
     */
    public compare(a32: Buffer, b32: Buffer): PixelDiff {
        if (a32.length !== PIXELS_LENGTH || b32.length !== PIXELS_LENGTH) {
            throw new Error(`Expected ${PIXELS_LENGTH}-byte 32x32 RGB buffers, got ${a32.length} and ${b32.length}`);
        }

        let total: number = 0;
        let worstBlock: number = 0;
        const blocks: number = PIXELS_EDGE / BLOCK_EDGE;
        const blockValues: number = BLOCK_EDGE * BLOCK_EDGE * PIXELS_CHANNELS;

        for (let blockY: number = 0; blockY < blocks; blockY++) {
            for (let blockX: number = 0; blockX < blocks; blockX++) {
                let blockTotal: number = 0;
                for (let y: number = 0; y < BLOCK_EDGE; y++) {
                    for (let x: number = 0; x < BLOCK_EDGE; x++) {
                        const pixel: number = (blockY * BLOCK_EDGE + y) * PIXELS_EDGE + blockX * BLOCK_EDGE + x;
                        for (let c: number = 0; c < PIXELS_CHANNELS; c++) {
                            const index: number = pixel * PIXELS_CHANNELS + c;
                            blockTotal += Math.abs(a32[index] - b32[index]);
                        }
                    }
                }
                total += blockTotal;
                worstBlock = Math.max(worstBlock, blockTotal / blockValues);
            }
        }

        return {meanDiff: total / PIXELS_LENGTH, worstBlock};
    }

    /**
     * Threshold verdict for one candidate pair. Any invalid input is "not a
     * duplicate": a redundant copy is cheaper than a lost image. Rules over
     * several candidates (e.g. "exactly one passes") belong to the caller.
     */
    public isDuplicate(metrics: PixelDiff, aspectA: number, aspectB: number): boolean {
        const aspectLogRatio: number = Math.abs(Math.log(aspectA / aspectB));
        return aspectA > 0 && aspectB > 0
            && Number.isFinite(aspectLogRatio) && aspectLogRatio <= this.thresholds.maxAspectLogRatio
            && Number.isFinite(metrics.meanDiff) && metrics.meanDiff <= this.thresholds.maxMeanDiff
            && Number.isFinite(metrics.worstBlock) && metrics.worstBlock <= this.thresholds.maxWorstBlock;
    }
}
