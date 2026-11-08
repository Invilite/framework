import type {NatsConnection, NatsError, Msg} from "nats";
import {SocketBroker, SocketBrokerSubscription} from "../../types/interfaces/SocketBroker";

/** Plain NATS publish/subscribe (no JetStream): an event reaches whoever listens at that moment, nothing is kept. */
export class NatsSocketBroker implements SocketBroker {
    private readonly encoder: TextEncoder = new TextEncoder();
    private readonly decoder: TextDecoder = new TextDecoder();

    public constructor(private readonly nats: NatsConnection) {
    }

    public publish(subject: string, payload: string): void {
        this.nats.publish(subject, this.encoder.encode(payload));
    }

    public subscribe(subject: string, deliver: (payload: string) => void, failed: (error: Error) => void): SocketBrokerSubscription {
        return this.nats.subscribe(subject, {
            callback: (error: NatsError | null, message: Msg): void => {
                if (error !== null) {
                    failed(error);
                    return;
                }
                try {
                    deliver(this.decoder.decode(message.data));
                } catch (deliverError: unknown) {
                    failed(deliverError instanceof Error ? deliverError : new Error(String(deliverError)));
                }
            },
        });
    }
}
