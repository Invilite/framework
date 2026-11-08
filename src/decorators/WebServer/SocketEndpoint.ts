import 'reflect-metadata';

const SOCKET_ENDPOINT_METADATA: string = 'SocketEndpoint';

export interface SocketEndpointDefinition {
    /** Full path of the socket, like in @WebSocketListener. */
    path: string;
}

/**
 * Accepts sockets under `path` and speaks the channel protocol on them. Goes on a class extending
 * AbstractSocketEndpoint in a `controllers/` directory; WebServer finds it there and checks it after the scan.
 */
export const SocketEndpoint: (path: string) => ClassDecorator = (path: string): ClassDecorator => {
    return (target: object): void => {
        Reflect.defineMetadata(SOCKET_ENDPOINT_METADATA, {path}, target);
    };
};

export function readSocketEndpoint(target: object): SocketEndpointDefinition | null {
    return Reflect.getOwnMetadata(SOCKET_ENDPOINT_METADATA, target) ?? null;
}
