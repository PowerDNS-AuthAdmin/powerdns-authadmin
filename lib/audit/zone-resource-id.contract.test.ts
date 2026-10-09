/**
 * lib/audit/zone-resource-id.contract.test.ts
 *
 * Contract: every audit row whose resource is a zone or an rrset carries a
 * resource id of the form `<server slug>:<zone>` (optionally with further
 * `:`-separated children). `zoneResourceScope` in
 * lib/db/repositories/audit-log.ts filters the per-zone change-log on exactly
 * that prefix, so a route that audits with a bare zone name or a PDNS zone id
 * writes rows the zone's History tab never shows - which is how cloned and
 * imported zones had no creation entry.
 *
 * Source-level check rather than a runtime one: the routes need a database
 * and a backend to run, and the shape of the id is decided where the call is
 * written. Every `appendAudit({ … resource: { type: "zone" | "rrset", id: … } })`
 * in app/ must build the id from a template literal whose first expression
 * is a `…slug` value followed by a literal `:`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Routes outside this change's ownership that still use a bare zone name.
 * Listed so the contract fails loudly if a NEW offender appears while the
 * known one is fixed in its own change (app/nic is a separate workstream).
 */
const KNOWN_EXCEPTIONS = new Set(["app/nic/update/route.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** `${something.slug}:` or `${slug}:` as the first thing in the template. */
const SLUG_PREFIXED = /^`\$\{[A-Za-z_][\w.]*[sS]lug\}:/;

interface Finding {
  file: string;
  line: number;
  idExpression: string;
}

function auditZoneResourceIds(file: string): Finding[] {
  const source = readFileSync(file, "utf8");
  const findings: Finding[] = [];
  // The id is either a whole template literal (which contains `}` of its
  // own, so it is matched as one unit) or a plain expression up to the
  // object's closing brace.
  const pattern =
    /resource:\s*\{\s*type:\s*"(?:zone|rrset)"\s*,\s*id:\s*(`(?:[^`\\]|\\.)*`|[^}`]+?)\s*,?\s*\}/g;
  for (const match of source.matchAll(pattern)) {
    const line = source.slice(0, match.index).split("\n").length;
    findings.push({ file: relative(ROOT, file), line, idExpression: match[1]!.trim() });
  }
  return findings;
}

describe("audit resource ids for zones and rrsets", () => {
  const findings = walk(join(ROOT, "app")).flatMap(auditZoneResourceIds);

  it("finds the audit call sites it is meant to guard", () => {
    // Sanity: a regex that silently matched nothing would make this suite vacuous.
    expect(findings.length).toBeGreaterThan(15);
  });

  it("every zone/rrset audit id is `${slug}:…` so the zone change-log can find it", () => {
    const offenders = findings.filter(
      (f) => !SLUG_PREFIXED.test(f.idExpression) && !KNOWN_EXCEPTIONS.has(f.file),
    );
    expect(offenders.map((f) => `${f.file}:${f.line} id: ${f.idExpression}`)).toEqual([]);
  });

  it("the exception list only names files that still need it", () => {
    const stillOffending = new Set(
      findings.filter((f) => !SLUG_PREFIXED.test(f.idExpression)).map((f) => f.file),
    );
    for (const file of KNOWN_EXCEPTIONS) {
      expect(stillOffending.has(file)).toBe(true);
    }
  });
});
