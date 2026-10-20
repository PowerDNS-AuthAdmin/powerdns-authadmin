/**
 * lib/dns/wire.ts
 *
 * A small DNS wire-format client for zone monitoring: build a query, send it
 * over UDP (TCP on truncation, or when asked), decode the whole message
 * including the authority and additional sections, and perform an AXFR.
 *
 * Why not `node:dns`: the system resolver hides exactly what monitoring needs
 * to see. A referral from a TLD server lives in the authority section, the AA
 * flag tells a lame server from an authoritative one, a serial per nameserver
 * needs a query to each address, and an open zone transfer can only be found
 * by asking for one. c-ares exposes none of that.
 *
 * Scope is deliberately narrow: IN class, the record types a delegation and
 * zone-health check reads (NS, A, AAAA, SOA, CNAME, PTR, MX, TXT, DS, DNSKEY,
 * RRSIG), EDNS0 with the DO bit, no DNSSEC validation. Unknown types keep
 * their raw RDATA so nothing is lost. Every call has a timeout and reads
 * nothing beyond one message (AXFR: until the closing SOA, with a size cap).
 */

import "server-only";
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { randomInt } from "node:crypto";

export const RRTYPE: Record<string, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  DS: 43,
  RRSIG: 46,
  NSEC: 47,
  DNSKEY: 48,
  NSEC3: 50,
  OPT: 41,
  AXFR: 252,
  ANY: 255,
};
const TYPE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(RRTYPE).map(([k, v]) => [v, k]),
);

export const RCODE: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
  9: "NOTAUTH",
};

export interface SoaRdata {
  mname: string;
  rname: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

export interface DsRdata {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

export interface DnskeyRdata {
  flags: number;
  protocol: number;
  algorithm: number;
  /** Base64 public key. */
  key: string;
  /** RFC 4034 appendix B key tag, computed from the RDATA. */
  keyTag: number;
}

export interface WireRecord {
  name: string;
  type: string;
  class: number;
  ttl: number;
  /** Presentation-ish form for simple types; hex for unknown ones. */
  data: string;
  soa?: SoaRdata;
  ds?: DsRdata;
  dnskey?: DnskeyRdata;
  /** RRSIG only: the type the signature covers. */
  rrsigCovers?: string;
}

export interface WireMessage {
  id: number;
  rcode: number;
  rcodeName: string;
  aa: boolean;
  tc: boolean;
  rd: boolean;
  ra: boolean;
  ad: boolean;
  question: { name: string; type: string } | null;
  answer: WireRecord[];
  authority: WireRecord[];
  additional: WireRecord[];
}

export interface QueryOptions {
  /** Server address (IPv4 or IPv6 literal). */
  server: string;
  port?: number;
  /** Ask for recursion (resolvers yes, authoritative servers no). Default false. */
  recursion?: boolean;
  /** EDNS0 DO bit: request DNSSEC records. Default false. */
  dnssec?: boolean;
  /** Force TCP (large answers, or UDP blocked). Default: UDP, then TCP on TC. */
  tcp?: boolean;
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ encode */

export function encodeName(name: string): Buffer {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const b = Buffer.from(label, "ascii");
    if (b.length > 63) throw new Error(`dns: label too long in ${name}`);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function encodeQuery(
  name: string,
  type: string,
  opts: { id?: number; recursion?: boolean; dnssec?: boolean; udpSize?: number } = {},
): { id: number; buf: Buffer } {
  const qtype = RRTYPE[type.toUpperCase()];
  if (qtype === undefined) throw new Error(`dns: unsupported qtype ${type}`);
  const id = opts.id ?? randomInt(0, 0xffff);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(opts.recursion ? 0x0100 : 0x0000, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10); // one OPT record
  const question = Buffer.concat([encodeName(name), Buffer.from([qtype >> 8, qtype & 0xff, 0, 1])]);
  // EDNS0: 1232 is the DNS-flag-day recommendation that avoids fragmentation.
  const opt = Buffer.alloc(11);
  opt.writeUInt16BE(RRTYPE["OPT"]!, 1);
  opt.writeUInt16BE(opts.udpSize ?? 1232, 3);
  opt.writeUInt32BE(opts.dnssec ? 0x00008000 : 0, 5);
  return { id, buf: Buffer.concat([header, question, opt]) };
}

/* ------------------------------------------------------------------ decode */

function readName(buf: Buffer, pos: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1;
  let hops = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error("dns: truncated name");
    const len = buf[pos]!;
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("dns: truncated pointer");
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (next === -1) next = pos + 2;
      if (ptr >= pos || ++hops > 64) throw new Error("dns: bad compression pointer");
      pos = ptr;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error("dns: unsupported label type");
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString("ascii"));
    pos += 1 + len;
  }
  return {
    name: labels.length ? `${labels.join(".").toLowerCase()}.` : ".",
    next: next === -1 ? pos : next,
  };
}

/** RFC 4034 appendix B. */
export function dnskeyKeyTag(rdata: Buffer): number {
  let ac = 0;
  for (let i = 0; i < rdata.length; i++) ac += i & 1 ? rdata[i]! : rdata[i]! << 8;
  ac += (ac >> 16) & 0xffff;
  return ac & 0xffff;
}

function decodeRdata(buf: Buffer, type: number, start: number, len: number): Partial<WireRecord> {
  const end = start + len;
  const slice = buf.subarray(start, end);
  switch (type) {
    case RRTYPE["A"]:
      return { data: len === 4 ? [...slice].join(".") : slice.toString("hex") };
    case RRTYPE["AAAA"]: {
      if (len !== 16) return { data: slice.toString("hex") };
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) groups.push(slice.readUInt16BE(i).toString(16));
      return { data: groups.join(":") };
    }
    case RRTYPE["NS"]:
    case RRTYPE["CNAME"]:
    case RRTYPE["PTR"]:
      return { data: readName(buf, start).name };
    case RRTYPE["MX"]: {
      const pref = buf.readUInt16BE(start);
      return { data: `${pref} ${readName(buf, start + 2).name}` };
    }
    case RRTYPE["TXT"]: {
      const chunks: string[] = [];
      let p = start;
      while (p < end) {
        const l = buf[p]!;
        chunks.push(
          `"${buf
            .subarray(p + 1, p + 1 + l)
            .toString("utf8")
            .replace(/["\\]/g, "\\$&")}"`,
        );
        p += 1 + l;
      }
      return { data: chunks.join(" ") };
    }
    case RRTYPE["SOA"]: {
      const m = readName(buf, start);
      const r = readName(buf, m.next);
      const p = r.next;
      const soa: SoaRdata = {
        mname: m.name,
        rname: r.name,
        serial: buf.readUInt32BE(p),
        refresh: buf.readUInt32BE(p + 4),
        retry: buf.readUInt32BE(p + 8),
        expire: buf.readUInt32BE(p + 12),
        minimum: buf.readUInt32BE(p + 16),
      };
      return {
        soa,
        data: `${soa.mname} ${soa.rname} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minimum}`,
      };
    }
    case RRTYPE["DS"]: {
      const ds: DsRdata = {
        keyTag: buf.readUInt16BE(start),
        algorithm: buf[start + 2]!,
        digestType: buf[start + 3]!,
        digest: buf
          .subarray(start + 4, end)
          .toString("hex")
          .toUpperCase(),
      };
      return { ds, data: `${ds.keyTag} ${ds.algorithm} ${ds.digestType} ${ds.digest}` };
    }
    case RRTYPE["DNSKEY"]: {
      const dnskey: DnskeyRdata = {
        flags: buf.readUInt16BE(start),
        protocol: buf[start + 2]!,
        algorithm: buf[start + 3]!,
        key: buf.subarray(start + 4, end).toString("base64"),
        keyTag: dnskeyKeyTag(slice),
      };
      return {
        dnskey,
        data: `${dnskey.flags} ${dnskey.protocol} ${dnskey.algorithm} ${dnskey.key}`,
      };
    }
    case RRTYPE["RRSIG"]: {
      const covered = buf.readUInt16BE(start);
      return { rrsigCovers: TYPE_NAME[covered] ?? String(covered), data: slice.toString("hex") };
    }
    default:
      return { data: slice.toString("hex") };
  }
}

export function decodeMessage(buf: Buffer): WireMessage {
  if (buf.length < 12) throw new Error("dns: message too short");
  const flags = buf.readUInt16BE(2);
  const counts = [
    buf.readUInt16BE(4),
    buf.readUInt16BE(6),
    buf.readUInt16BE(8),
    buf.readUInt16BE(10),
  ];
  let pos = 12;
  let question: WireMessage["question"] = null;
  for (let i = 0; i < counts[0]!; i++) {
    const q = readName(buf, pos);
    const qtype = buf.readUInt16BE(q.next);
    pos = q.next + 4;
    if (i === 0) question = { name: q.name, type: TYPE_NAME[qtype] ?? String(qtype) };
  }
  const section = (count: number): WireRecord[] => {
    const out: WireRecord[] = [];
    for (let i = 0; i < count; i++) {
      const n = readName(buf, pos);
      pos = n.next;
      const type = buf.readUInt16BE(pos);
      const klass = buf.readUInt16BE(pos + 2);
      const ttl = buf.readUInt32BE(pos + 4);
      const rdlen = buf.readUInt16BE(pos + 8);
      pos += 10;
      if (pos + rdlen > buf.length) throw new Error("dns: truncated rdata");
      if (type !== RRTYPE["OPT"]) {
        out.push({
          name: n.name,
          type: TYPE_NAME[type] ?? String(type),
          class: klass,
          ttl,
          data: "",
          ...decodeRdata(buf, type, pos, rdlen),
        });
      }
      pos += rdlen;
    }
    return out;
  };
  const answer = section(counts[1]!);
  const authority = section(counts[2]!);
  const additional = section(counts[3]!);
  const rcode = flags & 0x0f;
  return {
    id: buf.readUInt16BE(0),
    rcode,
    rcodeName: RCODE[rcode] ?? `RCODE${rcode}`,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    ad: (flags & 0x0020) !== 0,
    question,
    answer,
    authority,
    additional,
  };
}

/* --------------------------------------------------------------- transport */

const isV6 = (addr: string): boolean => addr.includes(":");

function sendUdp(buf: Buffer, server: string, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = createSocket(isV6(server) ? "udp6" : "udp4");
    const done = (fn: () => void) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`timeout after ${timeoutMs} ms`))),
      timeoutMs,
    );
    sock.once("message", (msg) => done(() => resolve(msg)));
    sock.once("error", (err) => done(() => reject(err)));
    sock.send(buf, port, server, (err) => {
      if (err) done(() => reject(err));
    });
  });
}

/**
 * One TCP exchange. `onMessage` returns true to keep reading (AXFR streams
 * several messages); the default stops after the first.
 */
function sendTcp(
  buf: Buffer,
  server: string,
  port: number,
  timeoutMs: number,
  onMessage: (msg: Buffer) => boolean,
  maxBytes: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: server, port });
    let pending = Buffer.alloc(0);
    let total = 0;
    let finished = false;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    sock.setTimeout(timeoutMs, () => finish(new Error(`timeout after ${timeoutMs} ms`)));
    sock.on("error", (err) => finish(err));
    sock.on("connect", () => {
      sock.write(Buffer.concat([Buffer.from([buf.length >> 8, buf.length & 0xff]), buf]));
    });
    sock.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) return finish(new Error(`response larger than ${maxBytes} bytes`));
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const len = pending.readUInt16BE(0);
        if (pending.length < 2 + len) break;
        const msg = pending.subarray(2, 2 + len);
        pending = pending.subarray(2 + len);
        // A throw here would escape the socket listener as an uncaught
        // exception; a malformed reply from a remote nameserver must only
        // fail this exchange.
        let more: boolean;
        try {
          more = onMessage(msg);
        } catch (err) {
          return finish(err instanceof Error ? err : new Error(String(err)));
        }
        if (!more) return finish();
      }
    });
    sock.on("end", () => finish());
  });
}

const MAX_TCP_RESPONSE = 4 * 1024 * 1024;

/**
 * Send one query and decode the reply. UDP first; a truncated reply (or
 * `tcp: true`) goes over TCP. A UDP timeout is retried once: datagrams get
 * lost, and one lost packet must not become a "nameserver down" finding.
 */
export async function query(name: string, type: string, opts: QueryOptions): Promise<WireMessage> {
  const port = opts.port ?? 53;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const { id, buf } = encodeQuery(name, type, { recursion: opts.recursion, dnssec: opts.dnssec });
  const viaTcp = async (): Promise<WireMessage> => {
    let out: WireMessage | null = null;
    await sendTcp(
      buf,
      opts.server,
      port,
      timeoutMs,
      (msg) => {
        out = decodeMessage(msg);
        return false;
      },
      MAX_TCP_RESPONSE,
    );
    if (!out) throw new Error("empty TCP response");
    return out;
  };
  if (opts.tcp) return viaTcp();
  let raw: Buffer;
  try {
    raw = await sendUdp(buf, opts.server, port, timeoutMs);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("timeout")) throw err;
    raw = await sendUdp(buf, opts.server, port, timeoutMs);
  }
  const msg = decodeMessage(raw);
  if (msg.id !== id) throw new Error("mismatched DNS message id");
  return msg.tc ? viaTcp() : msg;
}

export interface AxfrProbe {
  /** "open" = the server handed out the zone; "refused" = RCODE REFUSED/NOTAUTH; "error" = anything else. */
  result: "open" | "refused" | "error";
  rcodeName?: string;
  /** Records seen before the probe stopped (capped). */
  records: number;
  message?: string;
}

/**
 * Ask a nameserver for a zone transfer without a TSIG key. Monitoring runs
 * this against the zone's OWN nameservers only, to find transfers that are
 * open to the world. Reading stops at the first message (a server that is
 * going to refuse does so immediately; one that answers has already leaked
 * the zone), so a large zone is never pulled in full.
 */
export async function probeAxfr(zone: string, opts: QueryOptions): Promise<AxfrProbe> {
  const port = opts.port ?? 53;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const { buf } = encodeQuery(zone, "AXFR", {});
  let first: WireMessage | null = null;
  try {
    await sendTcp(
      buf,
      opts.server,
      port,
      timeoutMs,
      (msg) => {
        first = decodeMessage(msg);
        return false;
      },
      256 * 1024,
    );
  } catch (err) {
    return { result: "error", records: 0, message: err instanceof Error ? err.message : "unknown" };
  }
  const m = first as WireMessage | null;
  if (!m) return { result: "error", records: 0, message: "no response" };
  if (m.rcode !== 0) return { result: "refused", rcodeName: m.rcodeName, records: 0 };
  const open = m.answer.length > 0 && m.answer[0]!.type === "SOA";
  return { result: open ? "open" : "refused", rcodeName: m.rcodeName, records: m.answer.length };
}
