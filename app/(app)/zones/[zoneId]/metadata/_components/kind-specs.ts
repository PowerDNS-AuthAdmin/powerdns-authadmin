/**
 * Per-kind input spec. Drives `MetadataValuesInput` so the operator
 * gets the right control (toggle / dropdown / textarea) for the
 * metadata kind in play, and per-line validation where it makes
 * sense (CIDRs for ALLOW-AXFR-FROM, host:port for ALSO-NOTIFY, …).
 *
 * Anything not in this map falls through to a free-form textarea
 * with no validation - that covers `X-`-prefixed custom kinds and
 * any new kinds future PDNS versions add.
 *
 * `apiWritable: false` is set for kinds PDNS consistently lists in
 * `protectedOptions` across recent 4.x versions - DNSSEC state
 * (NSEC3PARAM, NSEC3NARROW, PRESIGNED) plus a couple of others that
 * the daemon owns (LUA-AXFR-SCRIPT, AXFR-MASTER-TSIG, TSIG-ALLOW-AXFR).
 * Those should be changed via the right PDNS surface (cryptokeys /
 * `pdnsutil`), not the metadata API. SOA-EDIT, SOA-EDIT-API and
 * API-RECTIFY are NOT metadata-API kinds at all on any current PDNS -
 * they're zone-object fields, so they live on `ZoneSettingsPanel`
 * instead of here.
 */
interface KindShapeBase {
  description: string;
  apiWritable?: boolean;
}
export type KindShape = KindShapeBase &
  (
    | { type: "bool" }
    | { type: "enum"; options: readonly string[] }
    | {
        type: "list";
        lineHint?: string;
        validate?: (line: string) => string | null;
      }
    | { type: "string" }
  );

const ipOrCidr = (line: string): string | null => {
  // Permissive IPv4/IPv6 + optional /mask. Strict-correct validation
  // happens server-side; this is just a "looks vaguely right" check
  // so the operator catches typos before round-tripping to PDNS.
  if (/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(line)) return null;
  if (/^[0-9.]+$/.test(line)) return null;
  if (/^[0-9a-fA-F:]+$/.test(line) && line.includes(":")) return null;
  return "Expected an IPv4/IPv6 address or CIDR.";
};

const hostPort = (line: string): string | null => {
  // `host[:port]` - host can be a hostname or an IP. Loose check; PDNS
  // does the strict parsing.
  if (/^[^:\s]+(:\d{1,5})?$/.test(line)) return null;
  if (/^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(line)) return null;
  return "Expected a host or host:port.";
};

export const KIND_SPECS: Record<string, KindShape> = {
  "ALLOW-AXFR-FROM": {
    type: "list",
    description: "CIDR ranges allowed to request a zone transfer (AXFR/IXFR).",
    lineHint: "10.0.0.0/8 or 2001:db8::/32",
    validate: ipOrCidr,
  },
  "ALLOW-DNSUPDATE-FROM": {
    type: "list",
    description: "CIDR ranges allowed to perform RFC 2136 dynamic updates.",
    lineHint: "10.0.0.0/8 or 2001:db8::/32",
    validate: ipOrCidr,
  },
  "ALSO-NOTIFY": {
    type: "list",
    description: "Additional NOTIFY targets beyond NS secondaries.",
    lineHint: "192.0.2.1 or 192.0.2.1:5300",
    validate: hostPort,
  },
  "AXFR-MASTER-TSIG": {
    type: "string",
    description: "TSIG key name used when this server pulls AXFR from its primary.",
    apiWritable: false,
  },
  "AXFR-SOURCE": {
    type: "string",
    description: "Local IP used as the source for outgoing AXFR.",
  },
  "FORWARD-DNSUPDATE": {
    type: "bool",
    description: "Forward dynamic updates to the configured primary.",
  },
  "GSS-ACCEPTOR-PRINCIPAL": {
    type: "string",
    description: "GSS-TSIG acceptor principal for this zone.",
  },
  "GSS-ALLOW-AXFR-PRINCIPAL": {
    type: "list",
    description: "GSS-TSIG principals allowed to request AXFR.",
  },
  IXFR: {
    type: "bool",
    description: "Enable IXFR for this zone.",
  },
  "LUA-AXFR-SCRIPT": {
    type: "string",
    description: "Path to a Lua script invoked during AXFR.",
    apiWritable: false,
  },
  "NOTIFY-DNSUPDATE": {
    type: "bool",
    description: "Emit NOTIFY after applying dynamic updates.",
  },
  NSEC3NARROW: {
    type: "bool",
    description: "Use NSEC3 narrow mode for this zone.",
    apiWritable: false,
  },
  NSEC3PARAM: {
    type: "string",
    description: "NSEC3 parameters: <hash-algo> <flags> <iterations> <salt>. e.g. '1 0 1 abcd'.",
    apiWritable: false,
  },
  PRESIGNED: {
    type: "bool",
    description: "The zone is signed externally; PDNS won't sign.",
    apiWritable: false,
  },
  "PUBLISH-CDNSKEY": {
    type: "bool",
    description: "Publish CDNSKEY records for KSKs in this zone.",
  },
  "PUBLISH-CDS": {
    type: "bool",
    description: "Publish CDS records for KSKs in this zone.",
  },
  "SLAVE-RENOTIFY": {
    type: "bool",
    description: "Re-emit NOTIFY after receiving AXFR as a secondary.",
  },
  "SOA-EDIT-DNSUPDATE": {
    type: "enum",
    options: ["DEFAULT", "INCREASE", "SOA-EDIT", "SOA-EDIT-INCREASE", "EPOCH", "NONE"],
    description: "Algorithm for SOA serial bump after RFC 2136 updates.",
  },
  "TSIG-ALLOW-AXFR": {
    type: "list",
    description: "TSIG key name(s) allowed to authorize a zone transfer.",
    lineHint: "key-name",
    apiWritable: false,
  },
  "TSIG-ALLOW-DNSUPDATE": {
    type: "list",
    description: "TSIG key name(s) allowed to authorize dynamic updates.",
    lineHint: "key-name",
  },
};

export function getKindSpec(kind: string): KindShape {
  return (
    KIND_SPECS[kind] ?? {
      type: "list",
      description: "Custom metadata kind - values are stored verbatim.",
    }
  );
}

/**
 * Whether the kind can be set via the PDNS HTTP API on a typical 4.9-era
 * server. Custom `X-`-prefixed kinds are always writable. Kinds we
 * explicitly flag with `apiWritable: false` (protected per PDNS source)
 * return false. Unknown kinds default to true - let the server reject
 * if it doesn't recognize them.
 */
export function isKindApiWritable(kind: string): boolean {
  if (kind.startsWith("X-")) return true;
  const spec = KIND_SPECS[kind];
  if (!spec) return true;
  return spec.apiWritable !== false;
}

/** True values per PDNS convention: `1`, `yes`, `true` (case-insensitive). */
export function isBoolTrue(v: string): boolean {
  return /^(1|yes|true)$/i.test(v.trim());
}

/**
 * Metadata kinds that PDNS surfaces as zone-object fields, not metadata-API
 * kinds. The list endpoint returns them, but they're managed by
 * `ZoneSettingsPanel` (which writes via `PUT /zones/{id}`), so the metadata
 * tab filters these out of its list and dropdown.
 */
export const ZONE_OBJECT_KINDS: ReadonlySet<string> = new Set([
  "SOA-EDIT",
  "SOA-EDIT-API",
  "API-RECTIFY",
]);
