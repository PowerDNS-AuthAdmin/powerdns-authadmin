/**
 * tests/integration/helpers/dns.ts
 *
 * Real DNS resolution against the PowerDNS Authoritative backends, used to
 * prove that what the app writes via the PDNS HTTP API is actually *served*
 * over DNS — and, for DNSSEC, that the zone is signed (DNSKEY at the apex,
 * RRSIG over the answers) on the primary and on its AXFR secondaries.
 *
 * The combined topology publishes each backend's port 53 to the host:
 *   - standalone primary  → 5310
 *   - ps-primary          → 5300
 *   - ps-secondary 1/2/3  → 5301 / 5302 / 5303
 *
 * Two layers:
 *   1. `Resolver` (node:dns) for record VALUES — A/AAAA/TXT/MX/CNAME/SOA/NS.
 *      It handles UDP, TCP fallback, and parsing for us.
 *   2. A tiny hand-rolled UDP/TCP query with the EDNS DO bit set for DNSSEC
 *      PRESENCE — node:dns can't request DNSKEY/RRSIG or read the DO flag.
 *      We only walk the record types (and the RRSIG "type covered" field),
 *      not their rdata, which keeps the parser small and robust.
 */

import { Resolver } from "node:dns/promises";
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { randomInt } from "node:crypto";

/** Host port → PDNS DNS endpoint, mirroring docker-compose-combined.yml. */
export const DNS_PORTS = {
  standalone: 5310,
  psPrimary: 5300,
  psSecondary1: 5301,
  psSecondary2: 5302,
  psSecondary3: 5303,
} as const;

const HOST = "127.0.0.1";

/** A `node:dns` resolver pinned to one backend's published DNS port. */
export function resolverFor(port: number): Resolver {
  const r = new Resolver({ timeout: 2000, tries: 2 });
  r.setServers([`${HOST}:${port}`]);
  return r;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Retry `fn` until it returns a truthy value or the deadline passes. Errors
 * thrown by `fn` (e.g. ENOTFOUND while a zone is still propagating to a
 * secondary, or a brief SERVFAIL right after securing) are swallowed and
 * retried. Throws the last error/`Error("poll timed out")` on timeout.
 */
export async function pollDns<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<NonNullable<T>> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const out = await fn();
      if (out) return out;
      lastErr = new Error(`predicate not satisfied${opts.label ? ` (${opts.label})` : ""}`);
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`pollDns timed out${opts.label ? ` (${opts.label})` : ""}`);
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Raw DNS query with the EDNS DO bit — for DNSSEC presence checks.
// ---------------------------------------------------------------------------

const RRTYPE: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  DS: 43,
  RRSIG: 46,
  NSEC: 47,
  DNSKEY: 48,
  NSEC3: 50,
  NSEC3PARAM: 51,
};
const RRTYPE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(RRTYPE).map(([k, v]) => [v, k]),
);

export interface RawRecord {
  type: string;
  /** For RRSIG only: the record type the signature covers (e.g. "A"). */
  rrsigCovers?: string;
}

export interface RawAnswer {
  rcode: number;
  /** True when the response carried the truncation bit before TCP retry. */
  truncated: boolean;
  answers: RawRecord[];
  authorities: RawRecord[];
}

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".").filter(Boolean);
  const bufs = parts.map((label) => {
    const b = Buffer.from(label, "ascii");
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function encodeQuery(name: string, type: string, dnssec: boolean): { id: number; buf: Buffer } {
  const id = randomInt(0, 0xffff);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0000, 2); // standard query, no recursion desired
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(0, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(dnssec ? 1 : 0, 10); // arcount (OPT when DNSSEC)

  const qtype = RRTYPE[type];
  if (qtype === undefined) throw new Error(`dns helper: unsupported qtype ${type}`);
  const question = Buffer.concat([
    encodeName(name),
    Buffer.from([qtype >> 8, qtype & 0xff, 0x00, 0x01]), // qtype + qclass IN
  ]);

  if (!dnssec) return { id, buf: Buffer.concat([header, question]) };

  // EDNS0 OPT pseudo-RR with the DO (DNSSEC OK) bit set.
  const opt = Buffer.alloc(11);
  opt.writeUInt8(0, 0); // root name
  opt.writeUInt16BE(41, 1); // type OPT
  opt.writeUInt16BE(4096, 3); // UDP payload size
  opt.writeUInt32BE(0x00008000, 5); // extended-rcode/version=0, DO bit set
  opt.writeUInt16BE(0, 9); // rdlen 0
  return { id, buf: Buffer.concat([header, question, opt]) };
}

/** Advance past a (possibly compressed) name; we don't need its value here. */
function skipName(buf: Buffer, pos: number): number {
  for (;;) {
    const len = buf[pos] ?? 0;
    if (len === 0) return pos + 1;
    if ((len & 0xc0) === 0xc0) return pos + 2; // pointer terminates the name
    pos += 1 + len;
  }
}

function decode(buf: Buffer): RawAnswer {
  const flags = buf.readUInt16BE(2);
  const rcode = flags & 0x0f;
  const truncated = (flags & 0x0200) !== 0;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);

  let pos = 12;
  for (let i = 0; i < qd; i++) pos = skipName(buf, pos) + 4; // name + qtype + qclass

  const readSection = (count: number): RawRecord[] => {
    const out: RawRecord[] = [];
    for (let i = 0; i < count; i++) {
      pos = skipName(buf, pos);
      const type = buf.readUInt16BE(pos);
      pos += 2 + 2 + 4; // type + class + ttl
      const rdlen = buf.readUInt16BE(pos);
      pos += 2;
      const rec: RawRecord = { type: RRTYPE_NAME[type] ?? String(type) };
      if (type === RRTYPE["RRSIG"] && rdlen >= 2) {
        const covered = buf.readUInt16BE(pos);
        rec.rrsigCovers = RRTYPE_NAME[covered] ?? String(covered);
      }
      pos += rdlen;
      out.push(rec);
    }
    return out;
  };

  const answers = readSection(an);
  const authorities = readSection(ns);
  return { rcode, truncated, answers, authorities };
}

function queryUdp(buf: Buffer, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`dns udp query to :${port} timed out`));
    }, timeoutMs);
    sock.once("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });
    sock.send(buf, port, HOST);
  });
}

function queryTcp(buf: Buffer, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: HOST, port });
    sock.setTimeout(timeoutMs);
    const framed = Buffer.concat([Buffer.from([buf.length >> 8, buf.length & 0xff]), buf]);
    const chunks: Buffer[] = [];
    let expected = -1;
    sock.on("connect", () => sock.write(framed));
    sock.on("data", (d) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      if (expected < 0 && all.length >= 2) expected = all.readUInt16BE(0);
      if (expected >= 0 && all.length >= expected + 2) {
        sock.destroy();
        resolve(all.subarray(2, expected + 2));
      }
    });
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error(`dns tcp query to :${port} timed out`));
    });
    sock.on("error", reject);
  });
}

/**
 * Send a single DNS query (DO bit optional) to a backend's published port and
 * return the decoded record types. Falls back to TCP when the UDP answer is
 * truncated (DNSSEC answers are large).
 */
export async function rawQuery(
  name: string,
  type: string,
  opts: { port: number; dnssec?: boolean; timeoutMs?: number },
): Promise<RawAnswer> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  const { buf } = encodeQuery(name, type, opts.dnssec ?? false);
  const udp = await queryUdp(buf, opts.port, timeoutMs);
  const first = decode(udp);
  if (!first.truncated) return first;
  const tcp = await queryTcp(buf, opts.port, timeoutMs);
  return decode(tcp);
}

/** True if the DO-bit answer for (name,type) carries an RRSIG covering `type`. */
export async function hasRrsig(name: string, type: string, port: number): Promise<boolean> {
  const res = await rawQuery(name, type, { port, dnssec: true });
  return res.answers.some((r) => r.type === "RRSIG" && r.rrsigCovers === type);
}

/** True if the apex serves at least one DNSKEY (zone is signed). */
export async function hasDnskey(zone: string, port: number): Promise<boolean> {
  const res = await rawQuery(zone, "DNSKEY", { port, dnssec: true });
  return res.answers.some((r) => r.type === "DNSKEY");
}
