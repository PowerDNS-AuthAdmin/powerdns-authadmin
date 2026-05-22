/**
 * lib/validators/rr-types/ds.ts
 *
 * DS (Delegation Signer) content — RFC 4034 § 5.3:
 *   `<key-tag> <algorithm> <digest-type> <digest>`
 *
 *   - key-tag    : uint16 (0–65535) — RFC 4034 § 5.3, computed from the
 *                  parent DNSKEY's RDATA.
 *   - algorithm  : uint8 (1–255) — IANA DNSSEC Algorithm Numbers registry.
 *                  Common values in deployment: 8 (RSASHA256), 13 (ECDSAP256),
 *                  14 (ECDSAP384), 15 (ED25519), 16 (ED448).
 *   - digest-type: uint8 (1–255) — IANA DS RR Digest Types.
 *                  1=SHA-1 (40 hex chars, deprecated for new), 2=SHA-256
 *                  (64 hex chars, REQUIRED per RFC 4509), 3=GOST R 34.11-94
 *                  (64 hex chars, RFC 5933 — niche/regional), 4=SHA-384
 *                  (96 hex chars, RFC 6605).
 *   - digest     : hex (case-insensitive) of exact length per digest-type.
 *                  PDNS accepts whitespace between groups; we normalize to
 *                  contiguous lowercase hex.
 *
 * Operators typically copy/paste DS records produced by `dnssec-dsfromkey`
 * or the upstream registrar's portal; this validator catches the
 * common paste-mistakes (wrong digest length, leftover formatting marks,
 * mistyped algorithm number).
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

/** Required hex length (lowercase) per digest-type per the relevant RFCs. */
const DIGEST_HEX_LENGTH: Record<number, { name: string; length: number; rfc: string }> = {
  1: { name: "SHA-1", length: 40, rfc: "RFC 4034" },
  2: { name: "SHA-256", length: 64, rfc: "RFC 4509" },
  3: { name: "GOST R 34.11-94", length: 64, rfc: "RFC 5933" },
  4: { name: "SHA-384", length: 96, rfc: "RFC 6605" },
};

/** IANA DNSSEC algorithm numbers in active deployment use. Outside this set
 * we warn (legacy / experimental) but don't error — operators occasionally
 * need to enter DS for an algorithm that's IANA-reserved but not widely
 * deployed. */
const COMMON_ALGORITHMS = new Set([
  5, 7, 8, 10, 12, 13, 14, 15, 16,
  // 5: RSASHA1, 7: RSASHA1-NSEC3-SHA1, 8: RSASHA256, 10: RSASHA512,
  // 12: ECC-GOST, 13: ECDSAP256, 14: ECDSAP384, 15: ED25519, 16: ED448.
]);

export const dsValidator: RRTypeValidator = {
  type: "DS",
  label: "Delegation Signer",
  description:
    "key-tag algorithm digest-type digest — pasted from your registrar or `dnssec-dsfromkey` output (RFC 4034 § 5.3).",
  placeholder: "12345 13 2 a1b2c3...64hex...",
  rfc: "RFC 4034 + RFC 4509",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    // The digest can be split across multiple whitespace-separated groups
    // (registrars sometimes print it that way). Treat anything after the
    // first three tokens as digest material.
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) {
      return {
        issues: [
          {
            level: "error",
            message:
              "DS content needs four parts: `<key-tag> <algorithm> <digest-type> <digest>` (RFC 4034 § 5.3).",
          },
        ],
        normalized: trimmed,
      };
    }
    const [, keyTagStr, algoStr, digestTypeStr, rawDigest] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];

    // key-tag: uint16
    let keyTag: number | null = null;
    if (!/^\d+$/.test(keyTagStr)) {
      issues.push({
        level: "error",
        message: `Key tag "${keyTagStr}" is not a non-negative integer.`,
      });
    } else {
      keyTag = Number(keyTagStr);
      if (keyTag < 0 || keyTag > 65535) {
        issues.push({
          level: "error",
          message: "Key tag must be 0–65535 (16-bit unsigned).",
        });
        keyTag = null;
      }
    }

    // algorithm: uint8
    let algorithm: number | null = null;
    if (!/^\d+$/.test(algoStr)) {
      issues.push({
        level: "error",
        message: `Algorithm "${algoStr}" is not a non-negative integer.`,
      });
    } else {
      algorithm = Number(algoStr);
      if (algorithm < 1 || algorithm > 255) {
        issues.push({
          level: "error",
          message: "Algorithm must be 1–255 (8-bit unsigned; 0 is reserved).",
        });
        algorithm = null;
      } else if (!COMMON_ALGORITHMS.has(algorithm)) {
        issues.push({
          level: "warning",
          message: `Algorithm ${algorithm} is outside the commonly-deployed set (5/7/8/10/12–16). Double-check the registrar's algorithm number.`,
        });
      }
    }

    // digest-type: uint8
    let digestType: number | null = null;
    if (!/^\d+$/.test(digestTypeStr)) {
      issues.push({
        level: "error",
        message: `Digest type "${digestTypeStr}" is not a non-negative integer.`,
      });
    } else {
      digestType = Number(digestTypeStr);
      if (digestType < 1 || digestType > 255) {
        issues.push({
          level: "error",
          message: "Digest type must be 1–255 (8-bit unsigned; 0 is reserved).",
        });
        digestType = null;
      }
    }

    // digest: hex, length depending on digest-type. Strip whitespace
    // operators commonly leave in when pasting from a registrar portal.
    const digestCompact = rawDigest.replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(digestCompact)) {
      issues.push({
        level: "error",
        message: "Digest must be hex (0–9, A–F). Strip any non-hex characters before saving.",
      });
    } else if (digestCompact.length === 0) {
      issues.push({
        level: "error",
        message: "Digest is empty.",
      });
    } else if (digestType !== null) {
      const spec = DIGEST_HEX_LENGTH[digestType];
      if (spec) {
        if (digestCompact.length !== spec.length) {
          issues.push({
            level: "error",
            message: `Digest-type ${digestType} (${spec.name}, ${spec.rfc}) requires ${spec.length} hex characters; got ${digestCompact.length}.`,
          });
        }
        if (digestType === 1) {
          issues.push({
            level: "warning",
            message:
              "Digest-type 1 (SHA-1) is deprecated for new DS records — registrars increasingly reject it. Prefer digest-type 2 (SHA-256).",
          });
        }
      } else {
        issues.push({
          level: "warning",
          message: `Digest-type ${digestType} is not in {1,2,3,4} — IANA-reserved but rarely deployed. Verify the registrar accepts it.`,
        });
      }
    }

    // Normalize: integer-cast each numeric field, lowercase + compact the
    // digest hex. Falls back to the original tokens when a field failed
    // validation so the saved row still makes sense.
    const normalizedParts: string[] = [
      keyTag !== null ? String(keyTag) : keyTagStr,
      algorithm !== null ? String(algorithm) : algoStr,
      digestType !== null ? String(digestType) : digestTypeStr,
      digestCompact || rawDigest.trim(),
    ];

    return {
      issues,
      normalized: normalizedParts.join(" "),
    };
  },
};
