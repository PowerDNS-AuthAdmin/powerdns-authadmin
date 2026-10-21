#!/usr/bin/env node
/**
 * scripts/demo-seed-ptr.mjs
 *
 * Demo/screenshots only. The combined stack's generated zones all sit in
 * 10.0.1.0/24 with no reverse zone, so the Reverse DNS report shows nothing
 * but "Not hosted". This adds `example.com.` (documentation addresses,
 * RFC 5737) and its reverse zone `2.0.192.in-addr.arpa.` to the standalone
 * demo backend, with one address per status: OK, missing, mismatch,
 * ambiguous and orphan. Zone Monitoring then also has a real, delegated
 * zone to check.
 *
 * Re-runnable: both zones are deleted and recreated. Talks to PowerDNS
 * directly, so nothing is audited.
 *
 *   node scripts/demo-seed-ptr.mjs
 *
 * Env: DEMO_PDNS_URL (default http://localhost:8095, the combined stack's
 * pdns-single API) and DEMO_PDNS_KEY (default single-changeme, its demo key).
 */

const BASE = process.env.DEMO_PDNS_URL ?? "http://localhost:8095";
const KEY = process.env.DEMO_PDNS_KEY ?? "single-changeme";
const ZONES = `${BASE}/api/v1/servers/localhost/zones`;

const rrset = (name, type, ...contents) => ({
  name,
  type,
  ttl: 3600,
  records: contents.map((content) => ({ content, disabled: false })),
});
const ptr = (last, target) => rrset(`${last}.2.0.192.in-addr.arpa.`, "PTR", target);
const nameservers = ["ns1.example.com.", "ns2.example.com."];

const forward = {
  name: "example.com.",
  kind: "Native",
  nameservers,
  rrsets: [
    rrset("ns1.example.com.", "A", "192.0.2.1"),
    rrset("ns2.example.com.", "A", "192.0.2.2"),
    rrset("example.com.", "A", "192.0.2.10"),
    rrset("www.example.com.", "A", "192.0.2.10"),
    rrset("mail.example.com.", "A", "192.0.2.20"),
    rrset("mail.example.com.", "MX", "10 mail.example.com."),
    rrset("api.example.com.", "A", "192.0.2.30"), // PTR points elsewhere: mismatch
    rrset("vpn.example.com.", "A", "192.0.2.40"), // no PTR: missing
    rrset("git.example.com.", "A", "192.0.2.50"),
    rrset("shop.example.com.", "A", "192.0.2.70"), // two names, no PTR: ambiguous
    rrset("store.example.com.", "A", "192.0.2.70"),
  ],
};

const reverse = {
  name: "2.0.192.in-addr.arpa.",
  kind: "Native",
  nameservers,
  rrsets: [
    ptr(1, "ns1.example.com."),
    ptr(2, "ns2.example.com."),
    ptr(10, "www.example.com."),
    ptr(20, "mail.example.com."),
    ptr(30, "old-api.example.com."),
    ptr(50, "git.example.com."),
    ptr(60, "retired.example.com."), // no forward record: orphan
  ],
};

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  }
}

for (const zone of [forward, reverse]) {
  await call("DELETE", `${ZONES}/${zone.name}`);
  await call("POST", ZONES, zone);
  console.log(`seeded ${zone.name}`);
}
