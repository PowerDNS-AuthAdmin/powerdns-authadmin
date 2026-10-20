/**
 * components/domain/zone-monitor-findings.tsx
 *
 * Presentational pieces of a zone monitoring result: the severity chip, the
 * findings list and the summary facts grid. Shared between the Zone
 * Monitoring page's row detail and anywhere else a result is shown (the
 * zone detail page can embed the same panel later), so the colours and the
 * wording of a verdict stay identical across surfaces.
 *
 * Tones map onto the app's semantic colour tokens: error red, warn amber,
 * success green; `info` is deliberately neutral so it never competes with
 * the two levels that need action.
 */

import type { ReactNode } from "react";
import {
  compareNameserverSets,
  describeFix,
  DELEGATION_HINT,
  DELEGATION_LABEL,
  formatDuration,
  plural,
  VERDICT_HINT,
  VERDICT_LABEL,
  verdictRank,
  type ZoneFinding,
  type ZoneMonitorResult,
  type ZoneVerdict,
} from "@/components/domain/zone-monitor-format";

export const VERDICT_CHIP_CLASS: Record<ZoneVerdict, string> = {
  error:
    "border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 text-[color:var(--color-error-fg)]",
  warn: "border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn-fg)]",
  info: "border-[color:var(--color-border)] bg-[color:var(--color-bg-muted)] text-[color:var(--color-fg-muted)]",
  ok: "border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 text-[color:var(--color-success-fg)]",
};

const VERDICT_DOT_CLASS: Record<ZoneVerdict, string> = {
  error: "bg-[color:var(--color-error)]",
  warn: "bg-[color:var(--color-warn)]",
  info: "bg-[color:var(--color-fg-muted)]",
  ok: "bg-[color:var(--color-success)]",
};

export function VerdictChip({ verdict, className }: { verdict: ZoneVerdict; className?: string }) {
  return (
    <span
      title={VERDICT_HINT[verdict]}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${VERDICT_CHIP_CLASS[verdict]} ${className ?? ""}`}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function HorizonChip({ horizon }: { horizon: ZoneMonitorResult["horizon"] }) {
  const tone =
    horizon === "internal"
      ? "bg-[color:var(--color-orange)]/15 text-[color:var(--color-orange-fg)]"
      : "bg-[color:var(--color-bg-muted)] text-[color:var(--color-fg-muted)]";
  return (
    <span
      className={`rounded px-1 py-0.5 font-mono text-[0.625rem] tracking-wide uppercase ${tone}`}
      title={
        horizon === "internal"
          ? "Internal zone: judged against its own nameservers and the internal resolvers only"
          : "Public zone: judged against the root servers and public resolvers"
      }
    >
      {horizon}
    </span>
  );
}

/**
 * The findings of one result, worst first, each with its stable code. A
 * finding with a suggested fix gets a one-line suggestion; `renderFixAction`
 * lets the page add the button that applies it, since applying is a write the
 * page owns (this component stays free of data fetching).
 */
export function FindingList({
  findings,
  renderFixAction,
}: {
  findings: readonly ZoneFinding[];
  renderFixAction?: (finding: ZoneFinding) => ReactNode;
}) {
  if (findings.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 shrink-0 rounded-full ${VERDICT_DOT_CLASS.ok}`} aria-hidden />
        <span>Every check passed.</span>
      </p>
    );
  }
  const ordered = [...findings].sort((a, b) => verdictRank(a.severity) - verdictRank(b.severity));
  return (
    <ul className="space-y-2">
      {ordered.map((f, idx) => (
        <li key={`${f.code}|${idx}`} className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
          <span
            className={`mt-1 h-2 w-2 rounded-full ${VERDICT_DOT_CLASS[f.severity]}`}
            aria-hidden
          />
          <span>
            <span className="sr-only">{VERDICT_LABEL[f.severity]}: </span>
            <span className="font-medium">{f.title}</span>{" "}
            <code className="font-mono text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              {f.code}
            </code>
            <span className="mt-0.5 block text-[color:var(--color-fg-muted)]">{f.detail}</span>
            {f.fix ? (
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{describeFix(f.fix)}</span>
                {renderFixAction?.(f)}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[color:var(--color-fg-muted)]">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

const MISSING_CLASS = "text-[color:var(--color-warn-fg)]";

/** The probe's raw observations behind the findings, as a compact definition grid. */
export function ResultSummary({ result }: { result: ZoneMonitorResult }) {
  const s = result.summary;
  const compareNs = s.delegation === "delegated";
  const nsSets = compareNameserverSets(s.apexNameservers, s.parentNameservers);
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_1fr]">
      <Fact label="Delegation">
        <span title={DELEGATION_HINT[s.delegation]}>{DELEGATION_LABEL[s.delegation]}</span>
        {s.serial !== null ? (
          <span className="text-[color:var(--color-fg-muted)]">
            {" "}
            · PowerDNS serial <span className="font-mono tabular-nums">{s.serial}</span>
          </span>
        ) : null}
        <span className="text-[color:var(--color-fg-muted)]">
          {" "}
          · checked in {formatDuration(result.durationMs)}
        </span>
      </Fact>

      <Fact label="Nameservers">
        {nsSets.length === 0 ? (
          <span className={MISSING_CLASS}>none at the apex</span>
        ) : (
          <ul className="space-y-0.5">
            {nsSets.map((entry) => {
              const differs = compareNs && entry.inApex !== entry.inParent;
              return (
                <li key={entry.name} className="font-mono">
                  <span className={differs ? MISSING_CLASS : ""}>{entry.name}</span>
                  {differs ? (
                    <span className="ml-2 font-sans text-[color:var(--color-fg-muted)]">
                      {entry.inApex ? "in the zone, not delegated" : "delegated, not in the zone"}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {compareNs ? (
          <span className="mt-1 block text-[color:var(--color-fg-muted)]">
            {plural(s.apexNameservers.length, "name")} at the apex,{" "}
            {plural(s.parentNameservers.length, "name")} at the parent.
          </span>
        ) : null}
      </Fact>

      <Fact label="Answers">
        {s.nameservers.length === 0 ? (
          <span className="text-[color:var(--color-fg-muted)]">no nameserver probed</span>
        ) : (
          <ul className="space-y-0.5">
            {s.nameservers.map((ns) => (
              <li key={ns.name}>
                <span className="font-mono">{ns.name}</span>{" "}
                <span className="text-[color:var(--color-fg-muted)]">
                  {ns.addresses.length === 0
                    ? "no address"
                    : ns.addresses
                        .map((address, idx) => {
                          const serial = ns.serials[idx];
                          return `${address}${serial !== null && serial !== undefined ? ` (serial ${serial})` : ""}`;
                        })
                        .join(", ")}
                  {ns.authoritative === null
                    ? ""
                    : ns.authoritative
                      ? ", authoritative"
                      : ", not authoritative"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Fact>

      <Fact label="Resolvers">
        {s.resolvers.length === 0 ? (
          <span className="text-[color:var(--color-fg-muted)]">none configured</span>
        ) : (
          <ul className="space-y-0.5">
            {s.resolvers.map((r) => (
              <li key={`${r.kind}|${r.address}`}>
                <span className="font-mono">{r.address}</span>{" "}
                <span className="text-[color:var(--color-fg-muted)]">
                  {r.kind} · {r.rcode ?? "no answer"}
                  {r.serial !== null ? ` · serial ${r.serial}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Fact>

      <Fact label="DNSSEC">
        {s.dnssec.signed ? "signed" : "unsigned"}
        {s.delegation === "delegated" || s.dnssec.dsAtParent > 0
          ? ` · ${plural(s.dnssec.dsAtParent, "DS record")} at the parent`
          : ""}
        {` · ${plural(s.dnssec.dnskeys, "DNSKEY")} served`}
      </Fact>

      <Fact label="Reverse DNS">
        {s.reverse === null ? (
          <span className="text-[color:var(--color-fg-muted)]">no address records</span>
        ) : (
          <>
            {plural(s.reverse.addresses, "address")}
            {s.reverse.missing > 0 ? (
              <span className={MISSING_CLASS}> · {s.reverse.missing} without PTR</span>
            ) : null}
            {s.reverse.mismatch > 0 ? (
              <span className={MISSING_CLASS}> · {s.reverse.mismatch} with a different PTR</span>
            ) : null}
            {s.reverse.missing === 0 && s.reverse.mismatch === 0 ? " · all PTRs match" : null}
          </>
        )}
      </Fact>
    </dl>
  );
}
