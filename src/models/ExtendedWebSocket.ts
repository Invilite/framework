import {WebSocket} from "ws";
import {AbstractLogger} from "../types/interfaces/AbstractLogger";

export interface ExtendedWebSocket extends WebSocket {
    logger: AbstractLogger;
    socketId: string;
}