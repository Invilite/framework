import fs from "fs";
import path from "path";
import {EmailTransporter} from "./EmailTransporter";
import AbstractEmailService from "./AbstractEmailService";
import Handlebars, {TemplateDelegate} from "handlebars";
import {SendEmailOptions} from "../../types/interfaces/SendEmail";

export default class HbsEmailService extends AbstractEmailService {

    public constructor(transporter: EmailTransporter, private readonly templatePath: string) {
        super(transporter);
    }

    public async send(from: string, to: string, subject: string, template: string, context: Record<string, string>, options?: SendEmailOptions): Promise<string> {
        const html: string = this.compileTemplate(template, context);
        const messageId: string = this.generateMessageId();

        await this.transporter.sendMail({
            from,
            to,
            subject,
            html,
            text: html.replace(/<[^>]+>/g, ""),
            messageId,
            ...(options?.attachments?.length ? {attachments: options.attachments} : {}),
        });

        return messageId;
    }

    protected compileTemplate(templateName: string, context: Record<string, string>): string {
        const filePath: string = path.join(this.templatePath, templateName + ".hbs");
        const source: string = fs.readFileSync(filePath, "utf8");
        const compiled: TemplateDelegate = Handlebars.compile(source);
        return compiled(context);
    }
}
