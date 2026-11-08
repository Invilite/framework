import {SocketBroker, SocketBrokerSubscription} from "../../types/interfaces/SocketBroker";

/**
 * Socket events within one process: synchronous delivery to whoever is subscribed to the exact subject. Enough for a
 * single application instance and for tests; several instances need a shared broker such as NatsSocketBroker.
 */
export class MemorySocketBroker implements SocketBroker {
    private readonly subscribers: Map<string, Set<(payload: string) => void>> = new Map<string, Set<(payload: string) => void>>();
    private readonly failures: Map<string, Set<(error: Error) => void>> = new Map<string, Set<(error: Error) => void>>();

    public publish(subject: string, payload: string): void {
        for (const deliver of [...(this.subscribers.get(subject) ?? [])]) {
            deliver(payload);
        }
    }

    public subscribe(subject: string, deliver: (payload: string) => void, failed: (error: Error) => void): SocketBrokerSubscription {
        const deliveries: Set<(payload: string) => void> = this.subscribers.get(subject) ?? new Set<(payload: string) => void>();
        const failureHandlers: Set<(error: Error) => void> = this.failures.get(subject) ?? new Set<(error: Error) => void>();
        deliveries.add(deliver);
        failureHandlers.add(failed);
        this.subscribers.set(subject, deliveries);
        this.failures.set(subject, failureHandlers);

        return {
            unsubscribe: (): void => {
                deliveries.delete(deliver);
                failureHandlers.delete(failed);
                if (deliveries.size === 0) {
                    this.subscribers.delete(subject);
                    this.failures.delete(subject);
                }
            },
        };
    }

    /** Subjects with at least one subscriber, sorted. */
    public subjects(): string[] {
        return [...this.subscribers.keys()].sort();
    }

    /** Ends every subscription of a subject the way a broker does on its own: the error is reported, nothing more arrives. */
    public fail(subject: string, error: Error = new Error('Subscription ended by the broker')): void {
        const failureHandlers: Set<(error: Error) => void> = this.failures.get(subject) ?? new Set<(error: Error) => void>();
        this.subscribers.delete(subject);
        this.failures.delete(subject);
        for (const failed of failureHandlers) {
            failed(error);
        }
    }
}
