import {EmailTransporter} from "./EmailTransporter";
import SendEmail, {SendEmailOptions} from "../../types/interfaces/SendEmail";
import {nanoid} from "nanoid";

export default abstract class AbstractEmailService implements SendEmail {
    protected readonly transporter: EmailTransporter;

    /**
     * @param transporter - an object implementing EmailTransporter.
     *                      When using nodemailer, pass nodemailer.createTransport(cfg)
     *                      directly – it is structurally compatible.
     */
    protected constructor(transporter: EmailTransporter) {
        this.transporter = transporter;
    }

    public abstract send(from: string, to: string, subject: string, template: string, context: Record<string, string>, options?: SendEmailOptions): Promise<string>;

    protected generateMessageId(): string {
        return nanoid(16);
    }
}
