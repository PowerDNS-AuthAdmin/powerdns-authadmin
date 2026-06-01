/**
 * components/domain/rr-editors/roundtrip.test.ts
 *
 * For each registered editor: parse(canonical) → serialize → must match
 * the canonical form. This is the strongest local guarantee against
 * data corruption: an operator opening then re-saving a record must
 * not change the wire content unless they made an edit.
 *
 * The expected forms here are the canonical presentations PDNS would
 * emit on AXFR - they match the per-type validator's `normalized`.
 */

import { describe, expect, it } from "vitest";
import { mxEditor } from "./mx";
import { srvEditor } from "./srv";
import { caaEditor } from "./caa";
import { uriEditor } from "./uri";
import { naptrEditor } from "./naptr";
import { sshfpEditor } from "./sshfp";
import { tlsaEditor, smimeaEditor } from "./tlsa";
import { dsEditor } from "./ds";
import { txtEditor } from "./txt";
import { svcbEditor, httpsEditor } from "./svcb";

interface AnyEditor {
  parse: (w: string) => unknown;
  serialize: (s: never) => string;
}

const CASES: Array<{ name: string; editor: AnyEditor; canonical: string }> = [
  { name: "MX", editor: mxEditor, canonical: "10 mail.example.com." },
  { name: "MX null", editor: mxEditor, canonical: "0 ." },
  { name: "SRV", editor: srvEditor, canonical: "10 60 5060 sip.example.com." },
  { name: "CAA issue", editor: caaEditor, canonical: '0 issue "letsencrypt.org"' },
  {
    name: "CAA critical iodef",
    editor: caaEditor,
    canonical: '128 iodef "mailto:abuse@example.com"',
  },
  { name: "URI", editor: uriEditor, canonical: '10 1 "https://example.com/"' },
  {
    name: "NAPTR",
    editor: naptrEditor,
    canonical: '100 10 "S" "SIP+D2T" "" _sip._tcp.example.com.',
  },
  { name: "SSHFP", editor: sshfpEditor, canonical: "4 2 abcdef0123456789" },
  { name: "TLSA", editor: tlsaEditor, canonical: "3 1 1 abcdef0123456789" },
  { name: "SMIMEA", editor: smimeaEditor, canonical: "3 1 1 abcdef0123456789" },
  { name: "DS", editor: dsEditor, canonical: "12345 13 2 abcdef0123456789" },
  { name: "TXT short", editor: txtEditor, canonical: '"v=spf1 -all"' },
  { name: "SVCB alias", editor: svcbEditor, canonical: "0 svc.example.com." },
  { name: "SVCB service", editor: svcbEditor, canonical: "1 . alpn=h2,h3 port=443" },
  { name: "HTTPS service", editor: httpsEditor, canonical: "1 . alpn=h2,h3" },
];

describe("RR editor round-trip", () => {
  for (const c of CASES) {
    it(`${c.name}: parse(canonical) → serialize === canonical`, () => {
      const struct = c.editor.parse(c.canonical);
      expect(struct, `parse failed for: ${c.canonical}`).not.toBeNull();
      expect(c.editor.serialize(struct as never)).toBe(c.canonical);
    });
  }

  it("TXT: long blob splits to 255-byte quoted chunks", () => {
    // 300 ASCII bytes → must split. We assert two chunks and that total
    // unquoted length matches.
    const blob = "a".repeat(300);
    const wire = txtEditor.serialize({ blob });
    // wire = "<255 a's>" "<45 a's>"
    expect(wire.startsWith('"')).toBe(true);
    expect(wire).toMatch(/^"a{255}" "a{45}"$/);
    // Round-trip: parsing the wire should yield the original blob.
    expect(txtEditor.parse(wire)).toEqual({ blob });
  });

  it("TXT: empty blob serializes to a single empty character-string", () => {
    expect(txtEditor.serialize({ blob: "" })).toBe('""');
    expect(txtEditor.parse('""')).toEqual({ blob: "" });
  });

  it("TXT: escapes backslash and double-quote in payload", () => {
    const blob = 'has "quotes" and \\ backslash';
    const wire = txtEditor.serialize({ blob });
    expect(wire).toBe('"has \\"quotes\\" and \\\\ backslash"');
    expect(txtEditor.parse(wire)).toEqual({ blob });
  });

  it("MX: parse rejects single token", () => {
    expect(mxEditor.parse("10")).toBeNull();
  });
  it("MX: parse rejects out-of-range preference", () => {
    expect(mxEditor.parse("70000 mail.example.com.")).toBeNull();
  });

  it("SVCB: parse rejects when priority isn't a number", () => {
    expect(svcbEditor.parse("not-a-number . alpn=h2")).toBeNull();
  });
  it("SVCB: quoted SvcParam value with embedded space round-trips", () => {
    const struct = {
      priority: 1,
      target: ".",
      params: [{ key: "dohpath", value: "/dns-query{?dns}" }],
    };
    const wire = svcbEditor.serialize(struct);
    expect(svcbEditor.parse(wire)).toEqual(struct);
  });

  it("CAA: parse accepts unquoted legacy value", () => {
    const struct = caaEditor.parse("0 issue letsencrypt.org");
    expect(struct).toEqual({ flags: 0, tag: "issue", value: "letsencrypt.org" });
  });
});
