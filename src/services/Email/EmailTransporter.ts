/**
 * Lightweight transporter interface that decouples email sending from any specific
 * library (nodemailer, node-mailjet, etc.). Implementations can wrap nodemailer's
 * Transporter, an AWS SES client, or any other mail-sending library.
 *
 * This interface mirrors the subset of nodemailer's sendMail contract that
 * AbstractEmailService and HbsEmailService actually consume, so nodemailer's
 * Transporter is structurally compatible without requiring an explicit import.
 */

export interface SendMailOptions {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    messageId?: string;
    attachments?: {filename: string; contentType: string; content: string}[];
}

export interface SendMailResult {
    messageId?: string;
}

export interface EmailTransporter {
    sendMail(options: SendMailOptions): Promise<SendMailResult>;
}
