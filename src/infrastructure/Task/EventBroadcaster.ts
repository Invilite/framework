import EventEmitter from "events";
import {BroadcastChannel} from "worker_threads";
import {Serializable} from "../../types/types/Serializable";

export class EventBroadcaster extends EventEmitter {
    protected readonly broadcastChannel: BroadcastChannel;

    public constructor(channel: string, cb?: (message: Serializable) => Promise<void> | void) {
        super();
        this.broadcastChannel = new BroadcastChannel(channel);
        if (cb !== undefined) {
            this.broadcastChannel.onmessage = async (event: any): Promise<void> => {
                try {
                    await cb(event.data);
                } catch (e) {
                    this.emit('error', e);
                }
            };
        } else {
            this.broadcastChannel.onmessage = (event: any): void => {
                this.emit('message', event.data, event.timeStamp);
            };
        }
    }

    public send(message: any): void {
        this.broadcastChannel.postMessage(message);
    }

    public close(): void {
        this.broadcastChannel.close();
    }
}