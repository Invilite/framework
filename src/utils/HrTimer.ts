
export class HrTimer {
    public static startTimer(): () => number {
        const startTime: [number, number] = process.hrtime();

        return () => {
            const endTime: [number, number] = process.hrtime(startTime);

            return (endTime[0] * 1000) + (Math.round(endTime[1] / 10000) / 100);
        }
    }
}