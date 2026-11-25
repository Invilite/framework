import 'reflect-metadata';

const SOCKET_CHANNEL_METADATA: string = 'SocketChannel';

export interface SocketChannelOptions {
    /** Events may be skipped for a client that cannot keep up (chat, counters); never for notifications. */
    lossy?: boolean;
    /** Path of the endpoint the channel belongs to; needed only when the application has more than one endpoint. */
    endpoint?: string;
    presence?: boolean;
}

export interface SocketChannelDefinition {
    type: string;
    lossy: boolean;
    endpoint: string | null;
    presence: boolean;
}

/**
 * Channels `type:key` of one type, e.g. `order:42`. Goes on a class extending AbstractSocketController in a
 * `controllers/` directory; WebServer finds it there and checks it after the scan.
 */
export const SocketChannel: (type: string, options?: SocketChannelOptions) => ClassDecorator = (type: string, options: SocketChannelOptions = {}): ClassDecorator => {
    return (target: object): void => {
        const definition: SocketChannelDefinition = {type, lossy: options.lossy === true, endpoint: options.endpoint ?? null, presence: options.presence === true};
        Reflect.defineMetadata(SOCKET_CHANNEL_METADATA, definition, target);
    };
};

export function readSocketChannel(target: object): SocketChannelDefinition | null {
    return Reflect.getOwnMetadata(SOCKET_CHANNEL_METADATA, target) ?? null;
}
