
export interface AbstractLogger {
    trace(...message: unknown[]): void;
    debug(...message: unknown[]): void;
    info(...message: unknown[]): void;
    notice(...message: unknown[]): void;
    warning(...message: unknown[]): void;
    error(...message: unknown[]): void;
    critical(...message: unknown[]): void;
    alert(...message: unknown[]): void;
    emergency(...message: unknown[]): void;
}