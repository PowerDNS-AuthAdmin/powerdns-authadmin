/**
 * lib/validators/rr-types/ns.ts
 *
 * NS content — RFC 1035 § 3.3.11: the authoritative name server for the
 * zone (or delegated subzone). Single domain name.
 */

import { validateHostname } from "./hostname";
import type { RRTypeValidator } from "./types";

export const nsValidator: RRTypeValidator = {
  type: "NS",
  label: "Name server",
  description: "Fully-qualified hostname of an authoritative name server (RFC 1035 § 3.3.11).",
  placeholder: "ns1.example.com.",
  rfc: "RFC 1035",
  validate(content: string) {
    const result = validateHostname(content.trim());
    return { issues: result.issues, normalized: result.normalized };
  },
};
