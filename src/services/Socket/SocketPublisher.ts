import {SocketBroker} from "../../types/interfaces/SocketBroker";
import {SocketChannelName, SocketProtocol} from "../../infrastructure/Server/socket/SocketProtocol";

export interface SocketPublisherOptions {
    /** First part of every broker subject, so two applications can share one broker. Default `ws`. */
    subjectPrefix?: string;
}

export interface SocketPublishOptions {
    /** Id of a connection that must not receive the event, usually the sender's (`context.connection.id`). */
    except?: string;
}

/**
 * Sends socket events from anywhere in the application to every instance. Registered in the ServiceContainer as
 * 'SocketPublisher' and given to WebServer in `options.socket`, so publishing and the hub share one broker and prefix.
 * Publish after the database commit: an event that is lost or comes twice must never matter for anything stored -
 * clients reread state when they need it.
 */
export class SocketPublisher {
    public readonly subjectPrefix: string;

    private static readonly SUBJECT_PREFIX_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,32}$/;

    public constructor(public readonly broker: SocketBroker, options: SocketPublisherOptions = {}) {
        const subjectPrefix: string = options.subjectPrefix ?? 'ws';
        if (!SocketPublisher.SUBJECT_PREFIX_PATTERN.test(subjectPrefix)) {
            throw new Error(`Invalid socket subject prefix "${subjectPrefix}"`);
        }
        this.subjectPrefix = subjectPrefix;
    }

    public publish(channel: string, type: string, data: unknown, options: SocketPublishOptions = {}): void {
        const name: SocketChannelName | null = SocketProtocol.parseChannel(channel);
        if (name === null || name.type === SocketProtocol.PERSONAL_CHANNEL) {
            throw new Error(`Invalid socket channel "${channel}"`);
        }
        this.broker.publish(SocketProtocol.subject(this.subjectPrefix, name.type, name.key), SocketPublisher.encode(type, data, options.except ?? null));
    }

    /** To every connection of one account listening on its personal channel `user`. */
    public toUser(userId: number, type: string, data: unknown): void {
        if (!Number.isInteger(userId) || userId <= 0) {
            throw new Error(`Invalid user id ${userId}`);
        }
        this.broker.publish(SocketProtocol.personalSubject(this.subjectPrefix, userId), SocketPublisher.encode(type, data, null));
    }

    private static encode(type: string, data: unknown, except: string | null): string {
        if (!SocketProtocol.isEventType(type)) {
            throw new Error(`Invalid socket event type "${type}"`);
        }
        const payload: string = SocketProtocol.encodeBusEvent(type, data, except);
        if (payload.length > SocketProtocol.MAX_EVENT_LENGTH) {
            throw new Error(`Socket event "${type}" is ${payload.length} characters, over ${SocketProtocol.MAX_EVENT_LENGTH}`);
        }

        return payload;
    }
}
