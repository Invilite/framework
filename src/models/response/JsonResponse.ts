import {AbstractResponse} from "./AbstractResponse";

export class JsonResponse extends AbstractResponse {
    public constructor(data: any) {
        super(data);
        this.setHeader('Content-Type', 'application/json');
    }

    public getData(): Buffer {
        return Buffer.from(JSON.stringify(this.data, (_, value) => {
            if (value instanceof Map) {
                return Object.fromEntries(value as Map<any, any>);
            }

            return value;
        }));
    }
}