import {SocketConnection} from "./SocketConnection";

/** One connection in one channel, as `join`, `leave` and `@SocketMessage` methods get it. */
export interface SocketContext<TAttributes extends object = Record<string, unknown>> {
    readonly connection: SocketConnection<TAttributes>;
    /** Full channel name, e.g. `order:42`. */
    readonly channel: string;
    /** The part after the type, e.g. `42`. */
    readonly key: string;
    /** Free for the controller: one object per connection and channel, empty at `join`, gone after `leave`. */
    readonly state: Record<string, unknown>;
}
