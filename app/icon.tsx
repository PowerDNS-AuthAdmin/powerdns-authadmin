/**
 * Inline-generated app icon. Next.js picks up `app/icon.tsx` at build
 * time and serves a 32×32 PNG at `/icon`, plus auto-injects the link
 * tag - no `public/favicon.ico` file needed.
 *
 * The shape is a stylised "P" mark (PDNS) on a transparent square,
 * tinted with the brand accent so it looks coherent in both light
 * and dark browser chrome.
 */

import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";
export const runtime = "nodejs";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#2563eb",
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 22,
        fontWeight: 700,
        fontFamily: "system-ui, sans-serif",
        borderRadius: 6,
      }}
    >
      AA
    </div>,
    size,
  );
}
