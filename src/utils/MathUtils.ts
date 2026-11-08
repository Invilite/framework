/**
 * Pure numeric primitives shared by scoring math.
 * Domain-agnostic by design - no domain concepts belong here.
 */
export class MathUtils {
    public static clamp(value: number, min: number = 0, max: number = 1): number {
        return Math.max(min, Math.min(max, value));
    }

    /** Map a value from [min, max] onto a clamped 0..1 range. */
    public static normalize(value: number, min: number, max: number): number {
        if (max <= min) {
            return 0;
        }

        return MathUtils.clamp((value - min) / (max - min));
    }

    public static round(value: number, decimals: number = 2): number {
        const factor: number = Math.pow(10, decimals);

        return Math.round(value * factor) / factor;
    }

    /**
     * Concave curve giving more weight to the first units of a range:
     * 0 -> 0, 1 -> 1, but reaches ~0.5 at ~0.29 of the range.
     */
    public static inverseLogCurve(normalized: number): number {
        const x: number = MathUtils.clamp(normalized);

        return 1 - Math.pow(1 - x, 2);
    }

    /** Symmetric saturation curve: any real number onto -1..1 (0 -> 0, negatives allowed). */
    public static tanhScale(value: number, scale: number): number {
        if (scale <= 0) {
            return 0;
        }

        return Math.tanh(value / scale);
    }

    /**
     * Saturation curve approaching 1 asymptotically: 1 - e^(-steepness * x).
     * Keeps values moderate across the range (never front-loads like inverseLogCurve).
     */
    public static exponentialApproach(normalized: number, steepness: number): number {
        const x: number = MathUtils.clamp(normalized);

        return 1 - Math.exp(-steepness * x);
    }
}
