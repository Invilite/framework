import ColorSpace, {ciede2000, Lab} from './ColorSpace';

export interface PaletteColor {
    hex: string;
    share: number;
}

export interface LabSample {
    lab: Lab;
    weight: number;
}

interface WeightedPoint {
    lab: Lab;
    weight: number;
}

interface Cluster {
    lab: Lab;
    weight: number;
}

const MERGE_DISTANCE: number = 8;
const ITERATIONS: number = 32;
const LAB_KEY_PRECISION: number = 6;

function round(value: number): string {
    return value.toFixed(LAB_KEY_PRECISION);
}

function comparePoints(first: WeightedPoint, second: WeightedPoint): number {
    if (first.lab.l !== second.lab.l) {
        return first.lab.l - second.lab.l;
    }
    if (first.lab.a !== second.lab.a) {
        return first.lab.a - second.lab.a;
    }
    return first.lab.b - second.lab.b;
}

function aggregate(samples: LabSample[]): WeightedPoint[] {
    const points: Map<string, WeightedPoint> = new Map<string, WeightedPoint>();
    for (const sample of samples) {
        if (!Number.isFinite(sample.weight) || sample.weight <= 0) {
            continue;
        }
        const key: string = `${round(sample.lab.l)}|${round(sample.lab.a)}|${round(sample.lab.b)}`;
        const existing: WeightedPoint | undefined = points.get(key);
        if (existing) {
            existing.weight += sample.weight;
        } else {
            points.set(key, {lab: {...sample.lab}, weight: sample.weight});
        }
    }
    return [...points.values()].sort(comparePoints);
}

function nearest(lab: Lab, centroids: Lab[]): {index: number; distance: number} {
    let bestIndex: number = 0;
    let bestDistance: number = Number.POSITIVE_INFINITY;
    for (let index: number = 0; index < centroids.length; index++) {
        const distance: number = ciede2000(lab, centroids[index]);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    return {index: bestIndex, distance: bestDistance};
}

function initialCentroids(points: WeightedPoint[], count: number): Lab[] {
    const centroids: Lab[] = [{...points[0].lab}];
    while (centroids.length < count) {
        let best: WeightedPoint | null = null;
        let bestDistance: number = -1;
        for (const point of points) {
            const distance: number = nearest(point.lab, centroids).distance;
            if (distance > bestDistance + 1e-9) {
                bestDistance = distance;
                best = point;
            }
        }
        if (best === null) {
            break;
        }
        centroids.push({...best.lab});
    }
    return centroids;
}

function weightedAverage(points: WeightedPoint[]): Lab {
    let total: number = 0;
    let l: number = 0;
    let a: number = 0;
    let b: number = 0;
    for (const point of points) {
        total += point.weight;
        l += point.lab.l * point.weight;
        a += point.lab.a * point.weight;
        b += point.lab.b * point.weight;
    }
    return {l: l / total, a: a / total, b: b / total};
}

function mergeCluster(first: Cluster, second: Cluster): Cluster {
    const weight: number = first.weight + second.weight;
    return {
        lab: {
            l: (first.lab.l * first.weight + second.lab.l * second.weight) / weight,
            a: (first.lab.a * first.weight + second.lab.a * second.weight) / weight,
            b: (first.lab.b * first.weight + second.lab.b * second.weight) / weight,
        },
        weight,
    };
}

function mergeClose(clusters: Cluster[]): Cluster[] {
    let merged: Cluster[] = clusters
        .filter((cluster: Cluster): boolean => cluster.weight > 0)
        .sort((first: Cluster, second: Cluster): number => second.weight - first.weight);
    let changed: boolean = true;
    while (changed) {
        changed = false;
        const next: Cluster[] = [];
        for (const cluster of merged) {
            let targetIndex: number = -1;
            for (let index: number = 0; index < next.length; index++) {
                if (ciede2000(next[index].lab, cluster.lab) < MERGE_DISTANCE) {
                    targetIndex = index;
                    break;
                }
            }
            if (targetIndex >= 0) {
                next[targetIndex] = mergeCluster(next[targetIndex], cluster);
                changed = true;
            } else {
                next.push({lab: {...cluster.lab}, weight: cluster.weight});
            }
        }
        merged = next.sort((first: Cluster, second: Cluster): number => second.weight - first.weight);
    }
    return merged;
}

function asPalette(clusters: Cluster[], total: number): PaletteColor[] {
    return clusters
        .filter((cluster: Cluster): boolean => cluster.weight > 0)
        .map((cluster: Cluster): PaletteColor => ({
            hex: ColorSpace.toHex(cluster.lab),
            share: cluster.weight / total,
        }))
        .sort((first: PaletteColor, second: PaletteColor): number =>
            second.share - first.share || first.hex.localeCompare(second.hex));
}

export function fromRgbPixels(pixels: Buffer, channels: number, count: number): PaletteColor[] {
    return ImagePalette.fromRgbPixels(pixels, channels, count);
}

export default class ImagePalette {
    public static fromRgbPixels(pixels: Buffer, channels: number, count: number): PaletteColor[] {
        if (!Number.isInteger(channels) || channels < 3 || channels > 4 || !Number.isInteger(count) || count < 1) {
            return [];
        }
        const samples: LabSample[] = [];
        for (let offset: number = 0; offset + channels <= pixels.length; offset += channels) {
            if (channels === 4 && pixels[offset + 3] === 0) {
                continue;
            }
            samples.push({
                lab: ColorSpace.fromRgb(pixels[offset], pixels[offset + 1], pixels[offset + 2]),
                weight: 1,
            });
        }
        return ImagePalette.fromLabSamples(samples, count);
    }

    public static fromLabSamples(samples: LabSample[], count: number): PaletteColor[] {
        if (!Number.isInteger(count) || count < 1) {
            return [];
        }
        const points: WeightedPoint[] = aggregate(samples);
        if (points.length === 0) {
            return [];
        }
        const totalWeight: number = points.reduce(
            (total: number, point: WeightedPoint): number => total + point.weight,
            0,
        );
        const clusterCount: number = Math.min(count, points.length);
        const centroids: Lab[] = initialCentroids(points, clusterCount);
        let assignments: number[] = [];

        for (let iteration: number = 0; iteration < ITERATIONS; iteration++) {
            const nextAssignments: number[] = points.map(
                (point: WeightedPoint): number => nearest(point.lab, centroids).index,
            );
            const stable: boolean = nextAssignments.length === assignments.length
                && nextAssignments.every((value: number, index: number): boolean => value === assignments[index]);
            if (stable) {
                break;
            }
            assignments = nextAssignments;

            for (let index: number = 0; index < centroids.length; index++) {
                const members: WeightedPoint[] = points.filter(
                    (point: WeightedPoint, pointIndex: number): boolean => assignments[pointIndex] === index,
                );
                if (members.length > 0) {
                    centroids[index] = weightedAverage(members);
                }
            }
        }

        const finalAssignments: number[] = points.map(
            (point: WeightedPoint): number => nearest(point.lab, centroids).index,
        );
        const clusters: Cluster[] = centroids.map((lab: Lab): Cluster => ({lab: {...lab}, weight: 0}));
        points.forEach((point: WeightedPoint, index: number): void => {
            const cluster: Cluster | undefined = clusters[finalAssignments[index]];
            if (cluster) {
                cluster.weight += point.weight;
            }
        });

        return asPalette(mergeClose(clusters), totalWeight);
    }
}

export {ImagePalette};
