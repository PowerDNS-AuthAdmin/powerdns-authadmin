import { describe, expect, it } from "vitest";
import { decodeMessage, dnskeyKeyTag, encodeName, encodeQuery } from "./wire";

/** Build a response the way a server would: header, the question, then records. */
function buildResponse(opts: {
  id: number;
  flags: number;
  question: { name: string; type: number };
  answer?: Buffer[];
  authority?: Buffer[];
  additional?: Buffer[];
}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id, 0);
  header.writeUInt16BE(opts.flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(opts.answer?.length ?? 0, 6);
  header.writeUInt16BE(opts.authority?.length ?? 0, 8);
  header.writeUInt16BE(opts.additional?.length ?? 0, 10);
  const q = Buffer.concat([
    encodeName(opts.question.name),
    Buffer.from([0, opts.question.type, 0, 1]),
  ]);
  return Buffer.concat([
    header,
    q,
    ...(opts.answer ?? []),
    ...(opts.authority ?? []),
    ...(opts.additional ?? []),
  ]);
}

function rr(name: string | Buffer, type: number, ttl: number, rdata: Buffer): Buffer {
  const n = typeof name === "string" ? encodeName(name) : name;
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(ttl, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([n, fixed, rdata]);
}

describe("encodeQuery", () => {
  it("writes a standard query with an EDNS0 OPT record", () => {
    const { id, buf } = encodeQuery("example.com.", "NS", { id: 0x1234 });
    expect(id).toBe(0x1234);
    expect(buf.readUInt16BE(0)).toBe(0x1234);
    expect(buf.readUInt16BE(2)).toBe(0); // no RD
    expect(buf.readUInt16BE(4)).toBe(1);
    expect(buf.readUInt16BE(10)).toBe(1); // OPT
    expect(buf.subarray(12, 25)).toEqual(Buffer.from("076578616d706c6503636f6d00", "hex"));
    const dnssec = encodeQuery("example.com.", "A", { id: 1, dnssec: true, recursion: true }).buf;
    expect(dnssec.readUInt16BE(2)).toBe(0x0100);
    expect(dnssec.readUInt32BE(dnssec.length - 6)).toBe(0x00008000);
  });
  it("rejects unknown types and over-long labels", () => {
    expect(() => encodeQuery("example.com.", "FOO")).toThrow(/unsupported/);
    expect(() => encodeName(`${"a".repeat(64)}.com.`)).toThrow(/too long/);
  });
});

describe("decodeMessage", () => {
  it("decodes an authoritative answer with SOA, NS, A, AAAA, MX and TXT", () => {
    const soa = Buffer.concat([
      encodeName("ns1.example.com."),
      encodeName("hostmaster.example.com."),
      Buffer.from([
        0, 0, 0, 42, 0, 0, 0x0e, 0x10, 0, 0, 0x03, 0x84, 0, 0x12, 0x75, 0, 0, 0, 0x01, 0x2c,
      ]),
    ]);
    const msg = decodeMessage(
      buildResponse({
        id: 7,
        flags: 0x8400, // QR + AA
        question: { name: "example.com.", type: 6 },
        answer: [
          rr("example.com.", 6, 300, soa),
          rr("example.com.", 2, 300, encodeName("ns1.example.com.")),
          rr(
            "example.com.",
            15,
            300,
            Buffer.concat([Buffer.from([0, 10]), encodeName("mail.example.com.")]),
          ),
          rr(
            "example.com.",
            16,
            300,
            Buffer.concat([Buffer.from([11]), Buffer.from("v=spf1 -all")]),
          ),
        ],
        additional: [
          rr("ns1.example.com.", 1, 300, Buffer.from([192, 0, 2, 1])),
          rr("ns1.example.com.", 28, 300, Buffer.from("20010db8000000000000000000000001", "hex")),
        ],
      }),
    );
    expect(msg).toMatchObject({
      id: 7,
      aa: true,
      tc: false,
      rcode: 0,
      rcodeName: "NOERROR",
      question: { name: "example.com.", type: "SOA" },
    });
    expect(msg.answer[0]!.soa).toEqual({
      mname: "ns1.example.com.",
      rname: "hostmaster.example.com.",
      serial: 42,
      refresh: 3600,
      retry: 900,
      expire: 1209600,
      minimum: 300,
    });
    expect(msg.answer[1]).toMatchObject({ type: "NS", data: "ns1.example.com." });
    expect(msg.answer[2]).toMatchObject({ type: "MX", data: "10 mail.example.com." });
    expect(msg.answer[3]).toMatchObject({ type: "TXT", data: '"v=spf1 -all"' });
    expect(msg.additional.map((r) => [r.type, r.data])).toEqual([
      ["A", "192.0.2.1"],
      ["AAAA", "2001:db8:0:0:0:0:0:1"],
    ]);
  });

  it("follows compression pointers and decodes a referral with DS", () => {
    // The question name sits at offset 12; records point at it with 0xc00c.
    const ptr = Buffer.from([0xc0, 0x0c]);
    const ds = Buffer.concat([
      Buffer.from([0x30, 0x39, 13, 2]),
      Buffer.from("ab".repeat(32), "hex"),
    ]);
    const msg = decodeMessage(
      buildResponse({
        id: 1,
        flags: 0x8000,
        question: { name: "example.com.", type: 2 },
        authority: [rr(ptr, 2, 172800, encodeName("a.iana-servers.net.")), rr(ptr, 43, 86400, ds)],
      }),
    );
    expect(msg.aa).toBe(false);
    expect(msg.authority[0]).toMatchObject({
      name: "example.com.",
      type: "NS",
      data: "a.iana-servers.net.",
    });
    expect(msg.authority[1]!.ds).toEqual({
      keyTag: 12345,
      algorithm: 13,
      digestType: 2,
      digest: "AB".repeat(32),
    });
  });

  it("computes the DNSKEY key tag (RFC 4034 appendix B.1 vector: 60485)", () => {
    const rdata = Buffer.concat([
      Buffer.from([1, 0, 3, 5]),
      Buffer.from(
        "AQOeiiR0GOMYkDshWoSKz9XzfwJr1AYtsmx3TGkJaNXVbfi/2pHm822aJ5iI9BMzNXxeYCmZDRD99WYwYqUSdjMmmAphXdvxegXd/M5+X7OrzKBaMbCVdFLUUh6DhweJBjEVv5f2wwjM9XzcnOf+EPbtG9DMBmADjFDc2w/rljwvFw==",
        "base64",
      ),
    ]);
    expect(dnskeyKeyTag(rdata)).toBe(60485);
  });

  it("rejects malformed messages instead of reading out of bounds", () => {
    expect(() => decodeMessage(Buffer.alloc(5))).toThrow(/short/);
    const loop = buildResponse({ id: 1, flags: 0x8000, question: { name: "a.", type: 1 } });
    // A record whose name is a pointer to itself.
    const bad = Buffer.concat([loop, Buffer.from([0xc0, loop.length]), Buffer.alloc(10)]);
    bad.writeUInt16BE(1, 6);
    expect(() => decodeMessage(bad)).toThrow(/pointer|truncated/);
  });
});
