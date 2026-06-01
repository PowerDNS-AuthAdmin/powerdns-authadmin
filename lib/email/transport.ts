/**
 * lib/email/transport.ts
 *
 * Nodemailer SMTP transport, configured entirely from env (see
 * `lib/env.ts` for the schema + cross-field validation). The
 * transport is built lazily on first use so a deploy that never sends
 * mail doesn't connect.
 *
 * Encryption shapes supported:
 *   • SMTP_SECURE=true              → implicit TLS (SMTPS, "secure: true"
 *                                     in nodemailer; typical port 465)
 *   • SMTP_STARTTLS=required        → plaintext open + STARTTLS; refuse
 *                                     to send if the server doesn't
 *                                     advertise it (port 587 / 25)
 *   • SMTP_STARTTLS=opportunistic   → STARTTLS if offered (default;
 *                                     plaintext otherwise)
 *   • SMTP_STARTTLS=disabled        → never STARTTLS (local relays,
 *                                     fakemail / mailpit / mailhog)
 *
 * Auth is optional: if SMTP_USERNAME + SMTP_PASSWORD are unset the
 * transport sends as an unauthenticated MUA, which is the right shape
 * for a private relay that allow-lists this app's source IP.
 */

import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

let cached: Transporter | null = null;

export function emailEnabled(): boolean {
  return Boolean(env.SMTP_HOST);
}

/**
 * Build (or return cached) nodemailer transport. Throws when the
 * caller forgot to gate on `emailEnabled()` - that's a bug, not a
 * runtime condition, because the env schema rejects partial SMTP
 * configs at boot.
 */
export function getMailTransport(): Transporter {
  if (cached) return cached;
  if (!env.SMTP_HOST) {
    throw new Error("getMailTransport called but SMTP_HOST is unset (gate on emailEnabled()).");
  }

  // Port default mirrors the encryption choice: 465 for implicit TLS,
  // 587 for STARTTLS, 25 for plaintext / opportunistic. Operators with
  // a non-standard port set SMTP_PORT explicitly.
  const port =
    env.SMTP_PORT ?? (env.SMTP_SECURE ? 465 : env.SMTP_STARTTLS === "required" ? 587 : 25);

  // Nodemailer's `requireTLS: true` enforces STARTTLS - the connection
  // is dropped if the server doesn't advertise STARTTLS in its EHLO.
  // For opportunistic mode we leave `requireTLS` off and let nodemailer
  // upgrade if possible. For disabled we set `ignoreTLS: true` so
  // nodemailer doesn't try to upgrade against a relay that doesn't
  // speak it.
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE,
    requireTLS: env.SMTP_STARTTLS === "required",
    ignoreTLS: env.SMTP_STARTTLS === "disabled",
    auth:
      env.SMTP_USERNAME && env.SMTP_PASSWORD
        ? { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD }
        : undefined,
    tls: { rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED },
    connectionTimeout: env.SMTP_TIMEOUT_MS,
    greetingTimeout: env.SMTP_TIMEOUT_MS,
    socketTimeout: env.SMTP_TIMEOUT_MS,
  });

  logger.info(
    {
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE,
      starttls: env.SMTP_STARTTLS,
      auth: Boolean(env.SMTP_USERNAME),
    },
    "email.transport.ready",
  );

  cached = transport;
  return transport;
}

/**
 * Build the From header. Prefer the human-readable form when
 * `SMTP_FROM_NAME` is set so recipient mail clients show the app's
 * name instead of an opaque address.
 */
export function fromHeader(): string {
  if (!env.SMTP_FROM) {
    throw new Error("fromHeader called but SMTP_FROM is unset.");
  }
  if (env.SMTP_FROM_NAME) {
    return `${env.SMTP_FROM_NAME} <${env.SMTP_FROM}>`;
  }
  return env.SMTP_FROM;
}
