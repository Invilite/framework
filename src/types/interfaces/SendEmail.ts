
/** File attached to an e-mail; `content` is the raw (not base64-encoded) text. */
export interface EmailAttachment {
    filename: string;
    /** Full MIME type, may carry parameters, e.g. `text/calendar; charset=utf-8; method=PUBLISH`. */
    contentType: string;
    content: string;
}

export interface SendEmailOptions {
    attachments?: EmailAttachment[];
}

export default interface SendEmail {
    send(from: string, to: string, subject: string, template: string, context: Record<string, string>, options?: SendEmailOptions): Promise<string>;
}
