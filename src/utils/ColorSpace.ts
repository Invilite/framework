export interface Lab {
    l: number;
    a: number;
    b: number;
}

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

const HEX_COLOR: RegExp = /^#([0-9a-fA-F]{6})$/;
const D65_X: number = 0.95047;
const D65_Y: number = 1;
const D65_Z: number = 1.08883;
const EPSILON: number = 216 / 24389;
const KAPPA: number = 24389 / 27;
const DEGREES: number = 180 / Math.PI;
const RADIANS: number = Math.PI / 180;

function linearize(value: number): number {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function gamma(value: number): number {
    return value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function f(value: number): number {
    return value > EPSILON ? Math.cbrt(value) : (KAPPA * value + 16) / 116;
}

function finv(value: number): number {
    const cube: number = value * value * value;
    return cube > EPSILON ? cube : (116 * value - 16) / KAPPA;
}

function hueDegrees(a: number, b: number): number {
    if (a === 0 && b === 0) {
        return 0;
    }
    const degrees: number = Math.atan2(b, a) * DEGREES;
    return degrees < 0 ? degrees + 360 : degrees;
}

export function ciede2000(first: Lab, second: Lab): number {
    const c1: number = Math.hypot(first.a, first.b);
    const c2: number = Math.hypot(second.a, second.b);
    const cAverage: number = (c1 + c2) / 2;
    const cAverageSeven: number = Math.pow(cAverage, 7);
    const g: number = 0.5 * (1 - Math.sqrt(cAverageSeven / (cAverageSeven + Math.pow(25, 7))));
    const a1: number = (1 + g) * first.a;
    const a2: number = (1 + g) * second.a;
    const c1Prime: number = Math.hypot(a1, first.b);
    const c2Prime: number = Math.hypot(a2, second.b);
    const h1Prime: number = hueDegrees(a1, first.b);
    const h2Prime: number = hueDegrees(a2, second.b);
    const deltaL: number = second.l - first.l;
    const deltaC: number = c2Prime - c1Prime;

    let deltaHue: number;
    if (c1Prime * c2Prime === 0) {
        deltaHue = 0;
    } else {
        deltaHue = h2Prime - h1Prime;
        if (deltaHue > 180) {
            deltaHue -= 360;
        } else if (deltaHue < -180) {
            deltaHue += 360;
        }
    }
    const deltaH: number = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin((deltaHue * RADIANS) / 2);

    const lAverage: number = (first.l + second.l) / 2;
    const cPrimeAverage: number = (c1Prime + c2Prime) / 2;
    let hPrimeAverage: number;
    if (c1Prime * c2Prime === 0) {
        hPrimeAverage = h1Prime + h2Prime;
    } else if (Math.abs(h1Prime - h2Prime) <= 180) {
        hPrimeAverage = (h1Prime + h2Prime) / 2;
    } else if (h1Prime + h2Prime < 360) {
        hPrimeAverage = (h1Prime + h2Prime + 360) / 2;
    } else {
        hPrimeAverage = (h1Prime + h2Prime - 360) / 2;
    }

    const t: number = 1
        - 0.17 * Math.cos((hPrimeAverage - 30) * RADIANS)
        + 0.24 * Math.cos(2 * hPrimeAverage * RADIANS)
        + 0.32 * Math.cos((3 * hPrimeAverage + 6) * RADIANS)
        - 0.20 * Math.cos((4 * hPrimeAverage - 63) * RADIANS);
    const deltaTheta: number = 30 * Math.exp(-Math.pow((hPrimeAverage - 275) / 25, 2));
    const cPrimeAverageSeven: number = Math.pow(cPrimeAverage, 7);
    const rc: number = 2 * Math.sqrt(cPrimeAverageSeven / (cPrimeAverageSeven + Math.pow(25, 7)));
    const sl: number = 1 + (0.015 * Math.pow(lAverage - 50, 2)) / Math.sqrt(20 + Math.pow(lAverage - 50, 2));
    const sc: number = 1 + 0.045 * cPrimeAverage;
    const sh: number = 1 + 0.015 * cPrimeAverage * t;
    const rt: number = -Math.sin(2 * deltaTheta * RADIANS) * rc;
    const lightness: number = deltaL / sl;
    const chroma: number = deltaC / sc;
    const hue: number = deltaH / sh;

    return Math.sqrt(
        lightness * lightness
        + chroma * chroma
        + hue * hue
        + rt * chroma * hue,
    );
}

export function hexToLab(hex: string): Lab {
    return ColorSpace.fromHex(hex);
}

export function labToHex(lab: Lab): string {
    return ColorSpace.toHex(lab);
}

export default class ColorSpace {
    public static fromRgb(red: number, green: number, blue: number): Lab {
        const r: number = linearize(Math.min(255, Math.max(0, red)) / 255);
        const g: number = linearize(Math.min(255, Math.max(0, green)) / 255);
        const b: number = linearize(Math.min(255, Math.max(0, blue)) / 255);

        const x: number = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
        const y: number = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
        const z: number = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

        const fx: number = f(x / D65_X);
        const fy: number = f(y / D65_Y);
        const fz: number = f(z / D65_Z);

        return {
            l: 116 * fy - 16,
            a: 500 * (fx - fy),
            b: 200 * (fy - fz),
        };
    }

    public static fromHex(hex: string): Lab {
        const match: RegExpMatchArray | null = HEX_COLOR.exec(hex.trim());
        if (match === null) {
            throw new Error(`Invalid sRGB hex colour: "${hex}"`);
        }
        const value: string = match[1];
        return ColorSpace.fromRgb(
            parseInt(value.slice(0, 2), 16),
            parseInt(value.slice(2, 4), 16),
            parseInt(value.slice(4, 6), 16),
        );
    }

    public static toRgb(lab: Lab): Rgb {
        const fy: number = (lab.l + 16) / 116;
        const fx: number = fy + lab.a / 500;
        const fz: number = fy - lab.b / 200;

        const x: number = D65_X * finv(fx);
        const y: number = D65_Y * finv(fy);
        const z: number = D65_Z * finv(fz);

        const r: number = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
        const g: number = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
        const b: number = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

        return {
            r: Math.round(Math.min(1, Math.max(0, gamma(r))) * 255),
            g: Math.round(Math.min(1, Math.max(0, gamma(g))) * 255),
            b: Math.round(Math.min(1, Math.max(0, gamma(b))) * 255),
        };
    }

    public static toHex(lab: Lab): string {
        return ColorSpace.hexFromRgb(ColorSpace.toRgb(lab));
    }

    public static hexFromRgb(rgb: Rgb): string {
        return `#${[rgb.r, rgb.g, rgb.b]
            .map((value: number): string => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase()}`;
    }

    public static ciede2000(first: Lab, second: Lab): number {
        return ciede2000(first, second);
    }
}

export {ColorSpace};
