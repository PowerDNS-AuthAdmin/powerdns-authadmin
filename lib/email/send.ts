/**
 * lib/email/send.ts
 *
 * Public email API. Every transactional send goes through `sendEmail()`
 * so we have ONE place to:
 *
 *   • Short-circuit when SMTP is disabled (no-op + log).
 *   • Tag every outbound message with our own Message-ID + headers so
 *     downstream MTAs can correlate bounces.
 *   • Audit the send (kind + recipient hash, never the body).
 *
 * Per-recipient send-rate limiting is not implemented yet; this single
 * chokepoint is where it would live if added.
 *
 * Direct calls to `transport.sendMail` are banned; the rule is enforced
 * by code review for now (the unique import path makes greps trivial).
 */

import "server-only";
import { emailEnabled, fromHeader, getMailTransport } from "./transport";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain-text body. ALWAYS provide this - some clients are
   *  plaintext-only, and our templates render to text first. */
  text: string;
  /** Optional HTML body. When present, recipients with HTML-capable
   *  clients see this; the text body remains the fallback. */
  html?: string;
  /**
   * Free-form tag used in logs + audit. Lets `grep email.send.ok
   * kind=password-reset` work across the fleet.
   */
  kind: string;
}

export interface SendEmailResult {
  ok: boolean;
  /** SMTP message id when the relay accepted the mail; null otherwise. */
  messageId: string | null;
  /** Redacted error string when ok=false. */
  error: string | null;
  /** True when SMTP was disabled and we no-op'd. Callers like
   *  password-reset still treat this as success so the request flow
   *  doesn't leak whether email was configured. */
  skipped: boolean;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!emailEnabled()) {
    logger.warn(
      { kind: input.kind, to: hashRecipient(input.to) },
      "email.send.skipped.smtp-disabled",
    );
    return { ok: true, messageId: null, error: null, skipped: true };
  }

  try {
    const transport = getMailTransport();
    // nodemailer's sendMail returns SentMessageInfo typed as
    // `unknown` under our @types/nodemailer version when the transport
    // is the SMTP one. Narrow on `messageId` defensively.
    const info: unknown = await transport.sendMail({
      from: fromHeader(),
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      // X-App-Kind is purely informational - useful when an operator
      // is filtering relay logs by which transactional flow the
      // message came from.
      headers: { "X-App-Kind": input.kind },
    });
    const messageId =
      typeof info === "object" &&
      info !== null &&
      "messageId" in info &&
      typeof (info as { messageId?: unknown }).messageId === "string"
        ? (info as { messageId: string }).messageId
        : null;
    logger.info({ kind: input.kind, to: hashRecipient(input.to), messageId }, "email.send.ok");
    return { ok: true, messageId, error: null, skipped: false };
  } catch (err) {
    const error = err instanceof Error ? redact(err.message) : "unknown";
    logger.warn({ kind: input.kind, to: hashRecipient(input.to), error }, "email.send.failed");
    return { ok: false, messageId: null, error, skipped: false };
  }
}

/**
 * Recipient identifier used in logs. Returns the email's hostname +
 * a short prefix so logs are debuggable without leaking the full
 * address (`alice@example.com` → `al***@example.com`).
 */
function hashRecipient(to: string): string {
  const at = to.indexOf("@");
  if (at < 0) return "***";
  const local = to.slice(0, at);
  const domain = to.slice(at + 1);
  const prefix = local.slice(0, 2);
  return `${prefix}***@${domain}`;
}
