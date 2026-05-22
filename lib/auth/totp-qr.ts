/**
 * lib/auth/totp-qr.ts
 *
 * Renders an `otpauth://` provisioning URI to an inline SVG QR code.
 * SVG (not PNG) so the result is crisp at any size, ~1.5KB on the
 * wire, and embeds straight into the response JSON without
 * base64-bloat. The TOTP enrollment route returns the SVG markup; the
 * client renders it via `dangerouslySetInnerHTML` (safe — the markup
 * is produced by `qrcode` from a value WE generated, not user input).
 *
 * Error correction level "M" is the authenticator-app convention —
 * survives a moderate amount of optical noise from camera scanning
 * without bloating the code's module count.
 */

import "server-only";
import QRCode from "qrcode";

export async function renderOtpAuthQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    // Color the modules to match our typical "ink on white"
    // authenticator-app look — leaving the dark color at #000 maximizes
    // contrast against the white background, which keeps cameras happy
    // even on dim phone screens.
    color: { dark: "#000000", light: "#ffffff" },
  });
}
