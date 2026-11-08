import HttpRequestReceivedEvent from "./HttpRequestReceivedEvent";

export default interface HttpRequestCompletedEvent extends HttpRequestReceivedEvent {
    statusCode: number;
    statusMessage: string;
    requestTime: number;
    processingTime: number | null;
    locals: Record<string, unknown>;
}
