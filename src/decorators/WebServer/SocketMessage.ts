import 'reflect-metadata';

const SOCKET_MESSAGES_METADATA: string = 'SocketMessages';

export interface SocketMessageDefinition {
    type: string;
    method: string;
}

/**
 * A client message of one type in the channel of a @SocketChannel class, e.g. `chat.message`. The method gets the
 * context and the unvalidated data; what it returns goes back to the sender in the `ack`.
 */
export const SocketMessage: (type: string) => MethodDecorator = (type: string): MethodDecorator => {
    return (target: object, propertyKey: string | symbol): void => {
        const messages: SocketMessageDefinition[] = Reflect.getOwnMetadata(SOCKET_MESSAGES_METADATA, target.constructor) ?? [];
        Reflect.defineMetadata(SOCKET_MESSAGES_METADATA, [...messages, {type, method: propertyKey.toString()}], target.constructor);
    };
};

export function readSocketMessages(target: object): SocketMessageDefinition[] {
    return Reflect.getOwnMetadata(SOCKET_MESSAGES_METADATA, target) ?? [];
}
