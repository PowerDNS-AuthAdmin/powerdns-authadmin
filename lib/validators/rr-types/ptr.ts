/**
 * lib/validators/rr-types/ptr.ts
 *
 * PTR content - RFC 1035 § 3.3.12: a single domain name. The RRset's name
 * lives in `in-addr.arpa.` (IPv4) or `ip6.arpa.` (IPv6); the content is the
 * forward name the IP resolves to.
 */

import { validateHostname } from "./hostname";
import type { RRTypeValidator } from "./types";

export const ptrValidator: RRTypeValidator = {
  type: "PTR",
  label: "Pointer target",
  description: "Fully-qualified hostname the reverse pointer resolves to (RFC 1035 § 3.3.12).",
  placeholder: "host.example.com.",
  rfc: "RFC 1035",
  validate(content: string) {
    const result = validateHostname(content.trim());
    return { issues: result.issues, normalized: result.normalized };
  },
};
