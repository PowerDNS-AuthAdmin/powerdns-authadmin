/**
 * lib/validators/rr-types/sshfp.ts
 *
 * SSHFP (SSH Public Key Fingerprint) content — RFC 4255 + RFC 6594 +
 * RFC 7479 + RFC 8709:
 *   `<algorithm> <fp-type> <fingerprint-hex>`
 *
 *   - algorithm : uint8 — IANA SSHFP algorithm registry.
 *                 1=RSA, 2=DSA (deprecated), 3=ECDSA, 4=ED25519, 6=ED448.
 *                 5 is reserved / unused.
 *   - fp-type   : uint8 — IANA SSHFP fingerprint type registry.
 *                 1=SHA-1 (40 hex chars, deprecated per RFC 6594),
 *                 2=SHA-256 (64 hex chars, current default).
 *   - fingerprint: hex (case-insensitive) of length matching fp-type.
 *                  `ssh-keygen -r` prints it with optional whitespace
 *                  inside the hex; we strip and lowercase.
 *
 * Common operator workflow: copy `IN SSHFP` records from `ssh-keygen
 * -r host.example.com` into a zone. This validator catches the
 * paste mistakes — wrong fingerprint length, algorithm/fp-type swap,
 * leftover formatting.
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

/** SSH algorithm code → display name + status. */
const ALGORITHMS: Record<number, { name: string; deprecated?: boolean }> = {
  1: { name: "RSA" },
  2: { name: "DSA", deprecated: true },
  3: { name: "ECDSA" },
  4: { name: "Ed25519" },
  6: { name: "Ed448" },
  // 5 is reserved / unallocated in IANA registry.
};

/** Fingerprint-type → required hex length + name. */
const FINGERPRINT_TYPES: Record<number, { name: string; length: number; deprecated?: boolean }> = {
  1: { name: "SHA-1", length: 40, deprecated: true },
  2: { name: "SHA-256", length: 64 },
};

export const sshfpValidator: RRTypeValidator = {
  type: "SSHFP",
  label: "SSH Public Key Fingerprint",
  description:
    "algorithm fp-type fingerprint — pasted from `ssh-keygen -r host` output (RFC 4255 + RFC 6594).",
  placeholder: "4 2 a1b2c3...64hex...",
  rfc: "RFC 4255 + RFC 6594 + RFC 7479 + RFC 8709",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    // Fingerprint may include whitespace when copy-pasted from
    // `ssh-keygen -r` output split across lines. Treat anything
    // after the first two tokens as fingerprint material.
    const match = /^(\S+)\s+(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) {
      return {
        issues: [
          {
            level: "error",
            message:
              "SSHFP content needs three parts: `<algorithm> <fp-type> <fingerprint>` (RFC 4255).",
          },
        ],
        normalized: trimmed,
      };
    }
    const [, algoStr, fpTypeStr, rawFp] = match as unknown as [string, string, string, string];

    // algorithm: uint8 in known set.
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
          message: "Algorithm must be 1–255 (8-bit unsigned).",
        });
        algorithm = null;
      } else {
        const spec = ALGORITHMS[algorithm];
        if (!spec) {
          issues.push({
            level: "warning",
            message: `Algorithm ${algorithm} is not in the IANA SSHFP registry (1=RSA, 3=ECDSA, 4=Ed25519, 6=Ed448 are deployed).`,
          });
        } else if (spec.deprecated) {
          issues.push({
            level: "warning",
            message: `Algorithm ${algorithm} (${spec.name}) is deprecated; modern hosts use Ed25519 (4) or ECDSA (3).`,
          });
        }
      }
    }

    // fp-type: uint8 in known set.
    let fpType: number | null = null;
    if (!/^\d+$/.test(fpTypeStr)) {
      issues.push({
        level: "error",
        message: `Fingerprint-type "${fpTypeStr}" is not a non-negative integer.`,
      });
    } else {
      fpType = Number(fpTypeStr);
      if (fpType < 1 || fpType > 255) {
        issues.push({
          level: "error",
          message: "Fingerprint-type must be 1–255 (8-bit unsigned).",
        });
        fpType = null;
      }
    }

    // fingerprint: hex, length per fp-type.
    const fpCompact = rawFp.replace(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(fpCompact)) {
      issues.push({
        level: "error",
        message: "Fingerprint must be hex (0–9, A–F). Strip any non-hex characters before saving.",
      });
    } else if (fpCompact.length === 0) {
      issues.push({
        level: "error",
        message: "Fingerprint is empty.",
      });
    } else if (fpType !== null) {
      const spec = FINGERPRINT_TYPES[fpType];
      if (spec) {
        if (fpCompact.length !== spec.length) {
          issues.push({
            level: "error",
            message: `Fingerprint-type ${fpType} (${spec.name}) requires ${spec.length} hex characters; got ${fpCompact.length}.`,
          });
        }
        if (spec.deprecated) {
          issues.push({
            level: "warning",
            message: `Fingerprint-type ${fpType} (${spec.name}) is deprecated per RFC 6594. Prefer fingerprint-type 2 (SHA-256).`,
          });
        }
      } else {
        issues.push({
          level: "warning",
          message: `Fingerprint-type ${fpType} is not in {1,2} — the IANA registry defines no others as of RFC 6594.`,
        });
      }
    }

    const normalizedParts: string[] = [
      algorithm !== null ? String(algorithm) : algoStr,
      fpType !== null ? String(fpType) : fpTypeStr,
      fpCompact || rawFp.trim(),
    ];

    return {
      issues,
      normalized: normalizedParts.join(" "),
    };
  },
};
