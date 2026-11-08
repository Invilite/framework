/** One socket connection as channel controllers see it; fixed for the life of the connection. */
export interface SocketConnection<TAttributes extends object = Record<string, unknown>> {
    /** Id of the socket, the one SocketServer logs; also what `SocketPublisher.publish(..., {except})` takes. */
    readonly id: string;
    /** Account from the access token at the upgrade, null for a guest. */
    readonly userId: number | null;
    /** What the endpoint's `connect` returned. */
    readonly attributes: Readonly<TAttributes>;
}
