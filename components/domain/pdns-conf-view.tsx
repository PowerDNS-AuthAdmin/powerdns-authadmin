/**
 * components/domain/pdns-conf-view.tsx
 *
 * Renders a curated, read-only subset of a PowerDNS daemon's settings the way
 * they'd appear in pdns.conf (`key=value`), with light syntax colouring.
 *
 * Purely presentational. No daemon secrets ever reach it: the caller passes an
 * allowlisted, secret-stripped set (see `lib/pdns/config-advice` →
 * `safeConfigSettings`). Static markup only, so it's CSP-safe with no
 * highlighter dependency.
 *
 * Row shape is inlined rather than imported from `lib/pdns` — the three-layer
 * boundary (ADR-0013) forbids `components/**` from importing the PDNS layer,
 * and structurally this matches `SafeConfigRow`.
 */

interface ConfRow {
  name: string;
  value: string;
}

/** Booleans carry meaning in pdns.conf, so tint yes/no; everything else neutral. */
function valueClass(value: string): string {
  const v = value.toLowerCase();
  if (v === "yes") return "text-[color:var(--color-success)]";
  if (v === "no") return "text-[color:var(--color-fg-muted)]";
  return "text-[color:var(--color-fg)]";
}

export function PdnsConfView({ rows, caption }: { rows: readonly ConfRow[]; caption?: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 font-mono text-xs leading-relaxed">
      <code>
        {caption ? (
          <span className="text-[color:var(--color-fg-subtle)]">{`# ${caption}\n`}</span>
        ) : null}
        {rows.map((r) => (
          <span key={r.name}>
            <span className="text-[color:var(--color-accent)]">{r.name}</span>
            <span className="text-[color:var(--color-fg-subtle)]">=</span>
            <span className={valueClass(r.value)}>{r.value}</span>
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
