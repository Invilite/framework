export interface SocketBrokerSubscription {
    unsubscribe(): void;
}

/** Fan-out of socket events between application instances; payloads are UTF-8 JSON text. */
export interface SocketBroker {
    publish(subject: string, payload: string): void;
    /** `failed` reports a subscription the broker ended on its own (permissions, slow consumer). */
    subscribe(subject: string, deliver: (payload: string) => void, failed: (error: Error) => void): SocketBrokerSubscription;
}
