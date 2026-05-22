/**
 * tests/integration/helpers/pdns.ts
 *
 * Raw PowerDNS Authoritative API client. Tests use this for two things:
 *
 *   1. **Cleanup** — before each test that touches PDNS, iterate over every
 *      registered backend and delete every zone, so tests don't pollute
 *      each other.
 *   2. **Verification** — after the app under test creates a zone or
 *      patches an RRset, hit the PDNS API directly to confirm the change
 *      landed in the backend (not just in our DB).
 *
 * The list of backends below mirrors the provisioning YAML for the
 * combined topology (3 multi-primary peers sharing one MariaDB, 1
 * standalone primary, 1 ps-primary + 3 ps-secondaries). Each entry pairs
 * a host port with the api-key set via the compose `command:` override.
 */

export interface PdnsBackend {
  /** Stable slug used in test error messages and assertions. */
  slug: string;
  /** Base URL reachable from the test process (host port mapping). */
  baseUrl: string;
  apiKey: string;
  /** Logical topology category for tests that branch on it. */
  topology: "multi-primary" | "standalone" | "ps-primary" | "ps-secondary";
}

export const PDNS_BACKENDS: PdnsBackend[] = [
  {
    slug: "peer-1",
    baseUrl: "http://localhost:8091/api/v1",
    apiKey: "peer-1-changeme",
    topology: "multi-primary",
  },
  {
    slug: "peer-2",
    baseUrl: "http://localhost:8092/api/v1",
    apiKey: "peer-2-changeme",
    topology: "multi-primary",
  },
  {
    slug: "peer-3",
    baseUrl: "http://localhost:8093/api/v1",
    apiKey: "peer-3-changeme",
    topology: "multi-primary",
  },
  {
    slug: "single",
    baseUrl: "http://localhost:8095/api/v1",
    apiKey: "single-changeme",
    topology: "standalone",
  },
  {
    slug: "ps-primary",
    baseUrl: "http://localhost:8081/api/v1",
    apiKey: "ps-primary-changeme",
    topology: "ps-primary",
  },
  {
    slug: "ps-secondary-1",
    baseUrl: "http://localhost:8082/api/v1",
    apiKey: "ps-secondary-1-changeme",
    topology: "ps-secondary",
  },
  {
    slug: "ps-secondary-2",
    baseUrl: "http://localhost:8083/api/v1",
    apiKey: "ps-secondary-2-changeme",
    topology: "ps-secondary",
  },
  {
    slug: "ps-secondary-3",
    baseUrl: "http://localhost:8084/api/v1",
    apiKey: "ps-secondary-3-changeme",
    topology: "ps-secondary",
  },
];

export const PDNS_BY_TOPOLOGY = {
  multiPrimaryAny: PDNS_BACKENDS.find((b) => b.topology === "multi-primary")!,
  standalone: PDNS_BACKENDS.find((b) => b.topology === "standalone")!,
  psPrimary: PDNS_BACKENDS.find((b) => b.topology === "ps-primary")!,
  psSecondaries: PDNS_BACKENDS.filter((b) => b.topology === "ps-secondary"),
};

export interface PdnsRRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
}

export interface PdnsZone {
  id: string;
  name: string;
  kind: string;
  serial?: number;
  rrsets?: PdnsRRset[];
}

async function pdnsCall(
  backend: PdnsBackend,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-api-key", backend.apiKey);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return fetch(`${backend.baseUrl}${path}`, { ...init, headers, body });
}

export async function listZones(backend: PdnsBackend): Promise<PdnsZone[]> {
  const res = await pdnsCall(backend, "/servers/localhost/zones");
  if (!res.ok) throw new Error(`[pdns] ${backend.slug} list zones → HTTP ${res.status}`);
  return (await res.json()) as PdnsZone[];
}

export async function getZone(backend: PdnsBackend, zoneId: string): Promise<PdnsZone> {
  const res = await pdnsCall(backend, `/servers/localhost/zones/${zoneId}`);
  if (!res.ok) throw new Error(`[pdns] ${backend.slug} get zone → HTTP ${res.status}`);
  return (await res.json()) as PdnsZone;
}

export async function deleteZone(backend: PdnsBackend, zoneId: string): Promise<void> {
  const res = await pdnsCall(backend, `/servers/localhost/zones/${zoneId}`, { method: "DELETE" });
  // 404 = already gone; 422 = "DNSSEC keys present" or another upstream
  // refusal (sometimes seen on shared-backend multi-primary clusters when
  // two peers race the same delete). Both are non-fatal for test cleanup —
  // the next test's own setup will write what it needs.
  if (!res.ok && res.status !== 404 && res.status !== 422 && res.status !== 409) {
    throw new Error(`[pdns] ${backend.slug} delete zone ${zoneId} → HTTP ${res.status}`);
  }
}

/**
 * Logical groupings of backends that share storage. Wiping zones via one
 * member of a shared group cleans the whole group — and avoids the race
 * where parallel DELETEs across peers of a multi-primary cluster collide
 * on the same row in MariaDB and one of them returns 422/409.
 *
 * ps-secondaries don't share storage with their primary; each has its own
 * SQLite. Deletes on the primary don't propagate (DNS has no NOTIFY-DELETE),
 * so the secondaries must be wiped individually.
 */
const WIPE_GROUPS: PdnsBackend[][] = [
  // Multi-primary cluster — 3 peers, 1 shared MariaDB. Wipe via peer-1 only.
  [PDNS_BACKENDS.find((b) => b.slug === "peer-1")!],
  [PDNS_BACKENDS.find((b) => b.slug === "single")!],
  [PDNS_BACKENDS.find((b) => b.slug === "ps-primary")!],
  [PDNS_BACKENDS.find((b) => b.slug === "ps-secondary-1")!],
  [PDNS_BACKENDS.find((b) => b.slug === "ps-secondary-2")!],
  [PDNS_BACKENDS.find((b) => b.slug === "ps-secondary-3")!],
];

/**
 * Wipe every zone from every distinct backend storage group. Idempotent;
 * tolerates transient peer outages (a stopped peer is reported as -1 in
 * the result instead of throwing). Returns count deleted per group leader.
 */
export async function wipeAllZones(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  await Promise.all(
    WIPE_GROUPS.map(async (group) => {
      const leader = group[0]!;
      let zones: PdnsZone[];
      try {
        zones = await listZones(leader);
      } catch {
        result[leader.slug] = -1;
        return;
      }
      // Serial deletes within a group so 422-races on shared backends
      // can't happen even across calls; cross-group is still parallel.
      for (const z of zones) {
        await deleteZone(leader, z.id);
      }
      result[leader.slug] = zones.length;
    }),
  );
  return result;
}
