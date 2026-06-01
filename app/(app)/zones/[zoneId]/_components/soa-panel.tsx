"use client";

/**
 * app/(app)/zones/[zoneId]/_components/soa-panel.tsx
 *
 * Structured SOA editor. Replaces "edit SOA as a record" - the operator
 * never types raw SOA RDATA. They see the fields that actually matter
 * (primary NS, responsible mailbox, the four timers) and serial is
 * displayed read-only because PowerDNS owns it.
 *
 * On save we build the canonical SOA content string, PATCH the RRset
 * through the same route the record editor uses, and refresh. RFC-1912
 * sanity warnings render inline.
 *
 * Mailbox encoding: RFC 1035 § 3.3.13 stores the responsible-party email
 * as a hostname with `@` replaced by `.` (and literal dots in the local
 * part escaped with `\`). The form takes / shows an email-style value
 * and translates on save / load.
 */

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "@/lib/client/api-fetch";
import { useDialog } from "@/components/ui/dialog";
import { NumberInput } from "./number-input";
import {
  SOA_DEFAULTS,
  serializeSoaContent,
  soaSanityWarnings,
  type SoaFields,
} from "@/lib/validators/soa";

interface SoaPanelProps {
  zoneName: string;
  serverSlug: string;
  zoneIdEncoded: string;
  /** Current SOA RDATA (parsed). Pass null when the zone has no SOA yet. */
  current: SoaFields | null;
  /** TTL of the SOA RRset. Default 3600 if no SOA exists yet. */
  ttl: number;
  canEdit: boolean;
}

interface DraftState {
  mname: string;
  rnameEmail: string;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

export function SoaPanel(props: SoaPanelProps) {
  const router = useRouter();
  const { toast } = useDialog();

  const initial: DraftState = useMemo(() => {
    if (props.current) {
      return {
        mname: stripTrailingDot(props.current.mname),
        rnameEmail: rnameToEmail(props.current.rname),
        refresh: props.current.refresh,
        retry: props.current.retry,
        expire: props.current.expire,
        minimum: props.current.minimum,
      };
    }
    return {
      mname: "",
      rnameEmail: "",
      refresh: SOA_DEFAULTS.refresh,
      retry: SOA_DEFAULTS.retry,
      expire: SOA_DEFAULTS.expire,
      minimum: SOA_DEFAULTS.minimum,
    };
    // `props.current` is a prop (the current SOA record), not a React ref -
    // the rule's `.current`-is-a-ref heuristic is a false positive here.
    // Recomputing when it changes is exactly the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.current]);

  const [draft, setDraft] = useState<DraftState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = !sameDraft(draft, initial);

  const draftFields: SoaFields = {
    mname: addTrailingDot(draft.mname),
    rname: emailToRname(draft.rnameEmail),
    serial: props.current?.serial ?? 0,
    refresh: draft.refresh,
    retry: draft.retry,
    expire: draft.expire,
    minimum: draft.minimum,
  };
  const warnings = soaSanityWarnings(draftFields);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.canEdit || !dirty) return;

    if (draft.mname.trim() === "") {
      setError("Primary name server is required.");
      return;
    }
    if (draft.rnameEmail.trim() === "") {
      setError("Responsible mailbox is required.");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const result = await mutate(`/api/admin/pdns/zones/${props.zoneIdEncoded}/rrsets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverSlug: props.serverSlug,
          changes: [
            {
              kind: "upsert" as const,
              name: props.zoneName,
              type: "SOA",
              ttl: props.ttl,
              records: [
                {
                  // Serial reuses the current value; PowerDNS auto-increments
                  // it on any zone PATCH so whatever we send here is replaced.
                  content: serializeSoaContent(draftFields),
                },
              ],
            },
          ],
        }),
      });

      if (!result.ok) {
        toast({
          kind: "error",
          title: "Could not save SOA",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "SOA updated." });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
      <header className="mb-4">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          SOA - zone timers
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          Start-of-authority record. PowerDNS manages the serial automatically; adjust the four
          timers and the responsible party here instead of editing SOA RDATA directly.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Primary name server (MNAME)"
            hint="Fully-qualified hostname of the master. Trailing dot added automatically."
          >
            <input
              value={draft.mname}
              onChange={(e) => setDraft({ ...draft, mname: e.target.value })}
              disabled={!props.canEdit}
              placeholder="ns1.example.com"
              className={inputClass}
            />
          </Field>
          <Field
            label="Responsible mailbox (RNAME)"
            hint="Email address. Stored as a hostname per RFC 1035 § 3.3.13."
          >
            <input
              type="email"
              value={draft.rnameEmail}
              onChange={(e) => setDraft({ ...draft, rnameEmail: e.target.value })}
              disabled={!props.canEdit}
              placeholder="hostmaster@example.com"
              className={inputClass}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TimerField
            label="Refresh"
            hint="How often secondaries poll the primary (seconds)."
            value={draft.refresh}
            onChange={(n) => setDraft({ ...draft, refresh: n })}
            disabled={!props.canEdit}
          />
          <TimerField
            label="Retry"
            hint="Wait between failed refresh attempts (seconds). Should be < refresh."
            value={draft.retry}
            onChange={(n) => setDraft({ ...draft, retry: n })}
            disabled={!props.canEdit}
          />
          <TimerField
            label="Expire"
            hint="Time a secondary serves the zone while the primary is unreachable (seconds)."
            value={draft.expire}
            onChange={(n) => setDraft({ ...draft, expire: n })}
            disabled={!props.canEdit}
          />
          <TimerField
            label="Minimum (negative-cache TTL)"
            hint="How long resolvers cache 'no such name' answers (RFC 2308)."
            value={draft.minimum}
            onChange={(n) => setDraft({ ...draft, minimum: n })}
            disabled={!props.canEdit}
          />
        </div>

        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-xs">
          <span className="font-medium text-[color:var(--color-fg-muted)]">Serial:</span>{" "}
          <span className="font-mono">{props.current?.serial ?? "-"}</span>
          <span className="ml-3 text-[color:var(--color-fg-subtle)]">
            (PowerDNS auto-increments on any zone change)
          </span>
        </div>

        {warnings.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-xs text-[color:var(--color-warn)]">
            {warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        ) : null}

        {error ? (
          <p className="text-sm text-[color:var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}

        {props.canEdit ? (
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setDraft(initial)}
              disabled={!dirty || saving}
              className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
            >
              Revert
            </button>
            <button
              type="submit"
              disabled={!dirty || saving}
              className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save SOA"}
            </button>
          </div>
        ) : (
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            Read-only - the record.update permission is required to edit SOA.
          </p>
        )}
      </form>
    </section>
  );
}

const inputClass =
  "mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-60";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{hint}</p> : null}
    </div>
  );
}

function TimerField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <NumberInput
        value={value}
        onChange={onChange}
        min={0}
        max={2_147_483_647}
        disabled={disabled}
        className={`${inputClass} font-mono`}
      />
    </Field>
  );
}

// =============================================================================
// Mailbox / hostname conversion helpers
// =============================================================================

function stripTrailingDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function addTrailingDot(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "";
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

/**
 * SOA RNAME → email. Replaces the first unescaped dot with `@` and unescapes
 * dots in the local part. Trailing dot stripped.
 */
function rnameToEmail(rname: string): string {
  const noDot = stripTrailingDot(rname);
  let local = "";
  let i = 0;
  while (i < noDot.length) {
    const ch = noDot.charAt(i);
    if (ch === "\\" && noDot.charAt(i + 1) === ".") {
      local += ".";
      i += 2;
    } else if (ch === ".") {
      return `${local}@${noDot.slice(i + 1)}`;
    } else {
      local += ch;
      i++;
    }
  }
  return local;
}

/**
 * Email → SOA RNAME. Escapes dots in the local part, joins with `.`, ensures
 * the result ends with a trailing dot. Accepts an already-SOA-encoded value
 * (no `@`) and just adds the trailing dot.
 */
function emailToRname(email: string): string {
  const trimmed = email.trim();
  if (trimmed === "") return "";
  const at = trimmed.indexOf("@");
  if (at === -1) {
    return addTrailingDot(trimmed);
  }
  // DNS master-file escaping: double a literal `\` before escaping `.` to `\.`,
  // otherwise an unescaped backslash in the local-part corrupts the rname.
  const local = trimmed.slice(0, at).replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  const domain = stripTrailingDot(trimmed.slice(at + 1));
  return `${local}.${domain}.`;
}

function sameDraft(a: DraftState, b: DraftState): boolean {
  return (
    a.mname === b.mname &&
    a.rnameEmail === b.rnameEmail &&
    a.refresh === b.refresh &&
    a.retry === b.retry &&
    a.expire === b.expire &&
    a.minimum === b.minimum
  );
}
