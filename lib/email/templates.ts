/**
 * lib/email/templates.ts
 *
 * Transactional email bodies (subject + plain-text + minimal HTML). Pure
 * functions - no I/O - so they're trivial to unit-test. Each takes the
 * action URL (which already carries its single-use token) and returns the
 * shape `sendEmail` expects. Plain text is always provided; HTML is a
 * progressive enhancement.
 */

import "server-only";

const PRODUCT = "PowerDNS-AuthAdmin";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function layout(bodyHtml: string): string {
  return (
    `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111827;max-width:520px;margin:0 auto;padding:24px">` +
    bodyHtml +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"><p style="color:#6b7280;font-size:12px">${PRODUCT}</p></body></html>`
  );
}

function button(url: string, label: string): string {
  const safe = escapeHtml(url);
  return (
    `<p><a href="${safe}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">${label}</a></p>` +
    `<p style="color:#6b7280;font-size:13px">Or paste this link into your browser:<br><a href="${safe}">${safe}</a></p>`
  );
}

export interface EmailBody {
  subject: string;
  text: string;
  html: string;
}

export function verifyEmailMessage(url: string): EmailBody {
  return {
    subject: `Verify your email - ${PRODUCT}`,
    text: `Confirm your email address to finish setting up your ${PRODUCT} account:\n\n${url}\n\nThis link expires for security. If you didn't request this, you can ignore this email.`,
    html: layout(
      `<h2 style="margin-top:0">Verify your email</h2><p>Confirm your email address to finish setting up your ${PRODUCT} account.</p>` +
        button(url, "Verify email") +
        `<p style="color:#6b7280;font-size:13px">If you didn't request this, you can ignore this email.</p>`,
    ),
  };
}

export function passwordResetMessage(url: string): EmailBody {
  return {
    subject: `Reset your password - ${PRODUCT}`,
    text: `A password reset was requested for your ${PRODUCT} account:\n\n${url}\n\nThis link expires for security. If you didn't request this, ignore this email - your password is unchanged.`,
    html: layout(
      `<h2 style="margin-top:0">Reset your password</h2><p>A password reset was requested for your ${PRODUCT} account.</p>` +
        button(url, "Reset password") +
        `<p style="color:#6b7280;font-size:13px">If you didn't request this, ignore this email - your password is unchanged.</p>`,
    ),
  };
}

export function emailChangeMessage(url: string): EmailBody {
  return {
    subject: `Confirm your new email - ${PRODUCT}`,
    text: `Confirm this address to make it your new ${PRODUCT} sign-in email:\n\n${url}\n\nThis link expires for security. If you didn't request this, you can ignore this email.`,
    html: layout(
      `<h2 style="margin-top:0">Confirm your new email</h2><p>Confirm this address to make it your new ${PRODUCT} sign-in email.</p>` +
        button(url, "Confirm email") +
        `<p style="color:#6b7280;font-size:13px">If you didn't request this, you can ignore this email.</p>`,
    ),
  };
}
