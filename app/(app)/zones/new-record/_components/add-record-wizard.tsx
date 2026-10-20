"use client";

/**
 * app/(app)/zones/new-record/_components/add-record-wizard.tsx
 *
 * The Add record wizard: horizon (when both exist), zone, record, review,
 * save, propagation, done. It writes through the same `PATCH .../rrsets`
 * the records editor uses, so validation, auto-PTR and the audit trail are
 * one code path; what it adds is the way in - an operator who knows the
 * record but not which backend hosts the zone starts from the Zones page
 * instead of hunting for the zone first.
 *
 * Data comes from four endpoints: `zones/search` (horizon totals, zone
 * type-ahead, URL prefill resolution), `zones/<zone>/records` (does this
 * owner+type already exist), `zones/<zone>/rrsets` (the write) and
 * `zones/<zone>/sync` (propagation, in `<PropagationStep>`).
 *
 * An existing RRset is never overwritten: the new value is appended and the
 * review step says so. The decisions that need no DOM live in
 * `components/domain/record-wizard-format.ts`.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Check, Info } from "lucide-react";
import { Field, inputClass } from "@/components/ui/form";
import { NumberInput } from "@/components/ui/number-input";
import { SelectMenu } from "@/components/ui/select-menu";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/components/ui/dialog";
import { useUnsavedChangesGuard } from "@/components/ui/use-unsaved-changes-guard";
import { RRContentField } from "@/components/domain/rr-editors";
import { ZoneHorizonBadge } from "@/components/domain/zone-horizon-badge";
import {
  buildUpsertChange,
  canonicalizeRecordName,
  describeExistingValues,
  describeRecordChange,
  recordsPageHref,
  wizardStartStep,
  WIZARD_DEFAULT_TTL,
  type ExistingRRset,
  type WizardHorizon,
  type WizardPrefill,
  type WizardZoneHit,
} from "@/components/domain/record-wizard-format";
import { mutate } from "@/lib/client/api-fetch";
import {
  describePtrOutcome,
  isAddressType,
  summarizePtrOutcomes,
  type AutoPtrOutcome,
} from "@/lib/dns/auto-ptr";
import { displayZoneName } from "@/lib/dns/zone-name";
import {
  defaultTypeForZone,
  getRRTypeValidator,
  hasErrors,
  typesForZone,
  type RRValidationResult,
} from "@/lib/validators/rr-types";
import { BareDiff, computeBindDiff } from "../../[zoneId]/_components/bare-diff";
import { PropagationStep } from "./propagation-step";
import { ZoneCombobox } from "./zone-combobox";

type Step = "loading" | "horizon" | "zone" | "record" | "review" | "propagation" | "done";

const EXISTENCE_DEBOUNCE_MS = 300;
/** Mirrors the `records` endpoint's owner-name check, so the wizard never sends a name it would reject. */
const OWNER_NAME_PATTERN = /^[A-Za-z0-9._\-*/@]{1,255}$/;

interface RecordForm {
  name: string;
  type: string;
  ttl: number;
  /** Once the operator edits the TTL, an existing RRset's TTL no longer overrides it. */
  ttlTouched: boolean;
  value: string;
  valueTouched: boolean;
  disabled: boolean;
  comment: string;
  ptr: boolean;
}

interface Existence {
  status: "idle" | "checking" | "ok" | "error";
  /** `${canonical name}|${type}` the result belongs to; stale results are ignored. */
  key: string;
  rrset: ExistingRRset | null;
  error: string | null;
}

interface SearchResponse {
  zones: WizardZoneHit[];
  total: number;
  horizons: { public: number; internal: number };
}

interface RecordsResponse {
  zone: string;
  name: string;
  exists: boolean;
  rrsets: ExistingRRset[];
}

const HORIZON_COPY: Record<WizardHorizon, { title: string; body: string }> = {
  public: {
    title: "Public",
    body: "Zones served to the internet.",
  },
  internal: {
    title: "Internal",
    body: "Split-horizon copies served only inside the network.",
  },
};

const IDLE_EXISTENCE: Existence = { status: "idle", key: "", rrset: null, error: null };

function emptyForm(type: string, prefill?: WizardPrefill): RecordForm {
  return {
    name: prefill?.name ?? "",
    type,
    ttl: WIZARD_DEFAULT_TTL,
    ttlTouched: false,
    value: prefill?.content ?? "",
    valueTouched: (prefill?.content ?? "") !== "",
    disabled: false,
    comment: "",
    ptr: false,
  };
}

export function AddRecordWizard({ prefill }: { prefill: WizardPrefill }) {
  const router = useRouter();
  const { toast } = useDialog();

  const [step, setStep] = useState<Step>("loading");
  const [bootError, setBootError] = useState<string | null>(null);
  const [horizons, setHorizons] = useState<{ public: number; internal: number } | null>(null);
  const [horizon, setHorizon] = useState<WizardHorizon | null>(null);
  const [zone, setZone] = useState<WizardZoneHit | null>(null);
  const [zoneNote, setZoneNote] = useState<string | null>(null);
  const [form, setForm] = useState<RecordForm>(() => emptyForm(prefill.type ?? "A", prefill));
  const [existence, setExistence] = useState<Existence>(IDLE_EXISTENCE);
  const [overrideErrors, setOverrideErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ serverSlug: string } | null>(null);

  const askHorizon = horizons !== null && horizons.public > 0 && horizons.internal > 0;

  // Boot: one search call gives the horizon totals and, for a deep link,
  // resolves the zone the URL named to its backend and permissions.
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const params = new URLSearchParams({
        q: prefill.zone ?? "",
        limit: prefill.zone ? "200" : "1",
      });
      const result = await mutate<SearchResponse>(
        `/api/admin/pdns/zones/search?${params.toString()}`,
      );
      if (cancelled) return;
      if (!result.ok) {
        setBootError(result.error);
        return;
      }
      const totals = result.data.horizons;
      setHorizons(totals);
      if (prefill.zone) {
        const hit =
          result.data.zones.find(
            (z) => z.name === prefill.zone && (!prefill.server || z.server === prefill.server),
          ) ?? null;
        if (hit?.canCreate) {
          setZone(hit);
          setHorizon(hit.horizon);
          setStep("record");
          return;
        }
        setZoneNote(
          hit
            ? `You may not add records to ${displayZoneName(hit.name)} on ${hit.serverName}. Pick another zone.`
            : `${displayZoneName(prefill.zone)} is not a zone you can read${prefill.server ? ` on ${prefill.server}` : ""}. Pick a zone below.`,
        );
        setHorizon(hit?.horizon ?? null);
        setStep("zone");
        return;
      }
      const start = wizardStartStep(totals, false);
      setHorizon(start.horizon);
      setStep(start.step);
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [prefill.zone, prefill.server]);

  // Type menu for the chosen zone: PTR first in a reverse zone. A deep-linked
  // type outside the allow-list is kept at the top so the link still works.
  const typeOptions = useMemo(() => {
    const allowed = zone ? typesForZone(zone.name) : typesForZone("");
    const types = allowed.includes(form.type) ? allowed : [form.type, ...allowed];
    return types.map((t) => ({
      value: t,
      label: t,
      description: getRRTypeValidator(t).label,
    }));
  }, [zone, form.type]);

  const canonicalName = zone ? canonicalizeRecordName(form.name, zone.name) : "";
  const nameValid = form.name.trim() === "" || OWNER_NAME_PATTERN.test(form.name.trim());

  // Existence check, debounced against typing in the name and type fields.
  // The verdict is kept through review and save (it decides create vs append)
  // and only re-checked when the operator is back on the record step.
  useEffect(() => {
    if (!zone || !nameValid) {
      setExistence(IDLE_EXISTENCE);
      return;
    }
    if (step !== "record") return;
    const key = `${canonicalName}|${form.type}`;
    setExistence({ status: "checking", key, rrset: null, error: null });
    const controller = new AbortController();
    const run = async () => {
      const params = new URLSearchParams({
        serverSlug: zone.server,
        name: form.name.trim() === "" ? "@" : form.name.trim(),
        type: form.type,
      });
      try {
        const response = await fetch(
          `/api/admin/pdns/zones/${encodeURIComponent(zone.name)}/records?${params.toString()}`,
          { signal: controller.signal },
        );
        const body = (await response.json().catch(() => null)) as
          | RecordsResponse
          | { error?: string }
          | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !body || !("rrsets" in body)) {
          setExistence({
            status: "error",
            key,
            rrset: null,
            error:
              body && "error" in body && typeof body.error === "string"
                ? body.error
                : "Could not check for an existing record.",
          });
          return;
        }
        const match = body.rrsets.find((rr) => rr.type === form.type) ?? null;
        setExistence({ status: "ok", key, rrset: match, error: null });
        // An appended value inherits the RRset's TTL unless the operator chose one.
        setForm((f) => (f.ttlTouched ? f : { ...f, ttl: match ? match.ttl : WIZARD_DEFAULT_TTL }));
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        setExistence({
          status: "error",
          key,
          rrset: null,
          error: err instanceof Error ? err.message : "Could not reach the server.",
        });
      }
    };
    const timer = setTimeout(() => void run(), EXISTENCE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [step, zone, canonicalName, form.name, form.type, nameValid]);

  const validator = getRRTypeValidator(form.type);
  const liveValidation: RRValidationResult | null =
    form.valueTouched && form.value.trim() !== "" ? validator.validate(form.value) : null;
  const hasValidationErrors = liveValidation !== null && hasErrors(liveValidation);
  const canReview =
    zone !== null &&
    nameValid &&
    form.value.trim() !== "" &&
    existence.status !== "checking" &&
    (!hasValidationErrors || overrideErrors);

  const existingForKey =
    existence.status === "ok" && existence.key === `${canonicalName}|${form.type}`
      ? existence.rrset
      : null;

  const staged = useMemo(() => {
    if (!zone) return null;
    return buildUpsertChange({
      zoneName: zone.name,
      name: form.name,
      type: form.type,
      ttl: form.ttl,
      content: form.value,
      disabled: form.disabled,
      comment: form.comment,
      ptr: form.ptr,
      existing: existingForKey,
    });
  }, [zone, form, existingForKey]);

  const dirty =
    saved === null &&
    (step === "record" || step === "review") &&
    (form.name !== "" || form.value !== "" || form.comment !== "");
  useUnsavedChangesGuard(dirty);

  function selectZone(hit: WizardZoneHit) {
    const sameZone = zone?.name === hit.name && zone.server === hit.server;
    setZone(hit);
    setHorizon(hit.horizon);
    setZoneNote(null);
    if (!sameZone) {
      setExistence(IDLE_EXISTENCE);
      // A type the new zone does not take (A in a reverse zone) falls back to
      // that zone's default; the value is cleared with it so it is re-validated.
      setForm((f) =>
        typesForZone(hit.name).includes(f.type)
          ? f
          : {
              ...f,
              type: defaultTypeForZone(hit.name),
              value: "",
              valueTouched: false,
              ptr: false,
            },
      );
    }
    setStep("record");
  }

  function onRecordSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canReview) return;
    setStep("review");
  }

  async function save() {
    if (!zone || !staged || saving) return;
    setSaving(true);
    try {
      const result = await mutate<{ ok: true; applied: number; ptr?: AutoPtrOutcome[] } | null>(
        `/api/admin/pdns/zones/${encodeURIComponent(zone.name)}/rrsets`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverSlug: zone.server, changes: [staged.change] }),
        },
      );
      if (!result.ok) {
        toast({ kind: "error", title: "Save failed", description: result.error });
        return;
      }
      // Same reporting as the records editor: the forward save succeeded;
      // whatever the PTR side could not do is said here, loudest first.
      const ptrOutcomes = result.data?.ptr ?? [];
      const ptrSummary = summarizePtrOutcomes(ptrOutcomes);
      const ptrDetail = ptrOutcomes
        .filter((o) => o.action === "skip" || o.action === "conflict" || o.action === "failed")
        .map(describePtrOutcome)
        .join(" ");
      const ptrSuffix = ptrSummary.text
        ? ` ${ptrSummary.text}${ptrDetail ? ` ${ptrDetail}` : ""}`
        : "";
      toast({
        kind:
          ptrSummary.level === "error" ? "error" : ptrSummary.level === "warn" ? "warn" : "success",
        ...(ptrSummary.level === "error" ? { title: "Saved, but reverse DNS failed" } : {}),
        description: describeRecordChange(staged.mode, staged.change, zone.name) + ptrSuffix,
      });
      setSaved({ serverSlug: zone.server });
      setStep("propagation");
    } finally {
      setSaving(false);
    }
  }

  function addAnother() {
    if (!zone) return;
    setForm(emptyForm(form.type));
    setExistence(IDLE_EXISTENCE);
    setOverrideErrors(false);
    setSaved(null);
    setStep("record");
  }

  const steps: Array<{ id: Step; label: string }> = [
    ...(askHorizon ? [{ id: "horizon" as Step, label: "Horizon" }] : []),
    { id: "zone", label: "Zone" },
    { id: "record", label: "Record" },
    { id: "review", label: "Review" },
    { id: "propagation", label: "Propagation" },
  ];
  const stepIndex = steps.findIndex((s) => s.id === step);

  if (bootError) {
    return (
      <p className="text-sm text-[color:var(--color-error-fg)]" role="alert">
        {bootError}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {step !== "loading" && step !== "done" ? (
        <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm" aria-label="Steps">
          {steps.map((s, i) => {
            const current = s.id === step;
            const done = stepIndex > i;
            return (
              <li
                key={s.id}
                aria-current={current ? "step" : undefined}
                className={`flex items-center gap-1.5 ${
                  current
                    ? "font-medium text-[color:var(--color-fg)]"
                    : "text-[color:var(--color-fg-muted)]"
                }`}
              >
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[0.6875rem] tabular-nums ${
                    done
                      ? "bg-[color:var(--color-success)] text-white"
                      : current
                        ? "bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]"
                        : "border border-[color:var(--color-border)]"
                  }`}
                  aria-hidden
                >
                  {done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                {s.label}
              </li>
            );
          })}
        </ol>
      ) : null}

      <section className="space-y-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4 sm:p-5">
        {step === "loading" ? (
          <p className="text-sm text-[color:var(--color-fg-muted)]" aria-live="polite">
            Loading your zones…
          </p>
        ) : null}

        {step === "horizon" && horizons ? (
          <HorizonStep
            horizons={horizons}
            value={horizon}
            onChange={setHorizon}
            onContinue={() => {
              if (horizon) setStep("zone");
            }}
          />
        ) : null}

        {step === "zone" ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-medium">Zone</h2>
              <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
                Start typing to search every {horizon ?? ""} zone you may read. Zones you may not
                add records to are listed but cannot be chosen.
              </p>
            </div>
            {zoneNote ? (
              <p
                className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-sm"
                role="status"
              >
                {zoneNote}
              </p>
            ) : null}
            <ZoneCombobox
              key={horizon ?? "any"}
              horizon={horizon}
              initialQuery={zone ? displayZoneName(zone.name) : displayZoneName(prefill.zone ?? "")}
              onSelect={selectZone}
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {askHorizon ? (
                <SecondaryButton onClick={() => setStep("horizon")}>Back</SecondaryButton>
              ) : null}
              {zone ? (
                <SecondaryButton onClick={() => setStep("record")}>
                  Keep {displayZoneName(zone.name)}
                </SecondaryButton>
              ) : null}
              <Link
                href="/zones"
                className="text-sm text-[color:var(--color-fg-muted)] underline-offset-4 hover:underline sm:ml-auto"
              >
                Cancel
              </Link>
            </div>
          </div>
        ) : null}

        {step === "record" && zone ? (
          <form onSubmit={onRecordSubmit} className="space-y-4" autoComplete="off">
            <div>
              <h2 className="text-lg font-medium">Record</h2>
              <ZoneSummary zone={zone} onChange={() => setStep("zone")} />
            </div>

            <Field
              label="Name"
              hint={`Relative ("www") or "@" for the zone apex. Stored as ${canonicalName}`}
              errors={nameValid ? undefined : ["Name contains characters DNS does not allow."]}
            >
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="www"
                autoComplete="off"
                spellCheck={false}
                autoFocus={!prefill.name}
                className={`${inputClass} font-mono`}
              />
            </Field>

            <Field label="Type" hint="Type a letter to jump: T for TXT, T again for TLSA.">
              <SelectMenu
                value={form.type}
                onChange={(nextType) => {
                  if (nextType === form.type) return;
                  setForm({ ...form, type: nextType, value: "", valueTouched: false, ptr: false });
                  setOverrideErrors(false);
                }}
                options={typeOptions}
                searchable
                searchPlaceholder="Filter types (TXT, mail, IPv6…)"
                className="mt-1 w-full"
              />
            </Field>

            <ExistenceStatus
              existence={existence}
              expectedKey={`${canonicalName}|${form.type}`}
              type={form.type}
              fqdn={canonicalName}
              zone={zone}
            />

            <Field
              label="TTL (seconds)"
              hint={
                existingForKey && !form.ttlTouched
                  ? `Matches the existing RRset's TTL (${existingForKey.ttl}). Changing it changes the TTL for every value with this name and type.`
                  : "Pre-filled with 3600; the zone's default applies on the records page."
              }
            >
              <NumberInput
                value={form.ttl}
                onChange={(n) => setForm({ ...form, ttl: n, ttlTouched: true })}
                min={0}
                className={inputClass}
              />
            </Field>

            <Field label="Value" hint={`${validator.label}. ${validator.description}`}>
              <RRContentField
                key={form.type}
                type={form.type}
                value={form.value}
                onChange={(next) => setForm({ ...form, value: next, valueTouched: true })}
                fallbackPlaceholder={validator.placeholder}
              />
            </Field>

            <Field
              label="Disabled"
              hint="A disabled record is kept in the zone for history but answered as if it did not exist."
            >
              <div className="mt-1 flex items-center gap-3">
                <Switch
                  checked={form.disabled}
                  onChange={(next) => setForm({ ...form, disabled: next })}
                  ariaLabel="Disabled"
                />
                <span className="text-sm">{form.disabled ? "Disabled" : "Enabled"}</span>
              </div>
            </Field>

            {isAddressType(form.type) ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.ptr}
                  onChange={(e) => setForm({ ...form, ptr: e.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  Keep the reverse (PTR) record in sync
                  <span className="mt-0.5 block text-xs text-[color:var(--color-fg-muted)]">
                    Creates or updates the PTR for this address in a reverse zone hosted here. Left
                    unticked, the zone&apos;s own auto-PTR setting decides.
                  </span>
                </span>
              </label>
            ) : null}

            <Field
              label="Comment"
              hint="Free-form note attached to the RRset (shared by every value of this name and type)."
            >
              <textarea
                value={form.comment}
                onChange={(e) => setForm({ ...form, comment: e.target.value })}
                rows={2}
                placeholder="Optional"
                className={inputClass}
              />
            </Field>

            {liveValidation && liveValidation.issues.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {liveValidation.issues.map((issue, index) => (
                  <li
                    key={index}
                    className={
                      issue.level === "error"
                        ? "text-[color:var(--color-error-fg)]"
                        : "text-[color:var(--color-warn-fg)]"
                    }
                  >
                    {issue.level === "error" ? "Error: " : "Warning: "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {hasValidationErrors ? (
              <label className="flex items-start gap-2 rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-sm">
                <input
                  type="checkbox"
                  checked={overrideErrors}
                  onChange={(e) => setOverrideErrors(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Save anyway - I&apos;ve reviewed the validation errors and want to publish this
                  content. The audit log captures the saved value verbatim.
                </span>
              </label>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="submit"
                disabled={!canReview}
                className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
              >
                Review changes
              </button>
              <SecondaryButton onClick={() => setStep("zone")}>Back</SecondaryButton>
            </div>
          </form>
        ) : null}

        {step === "review" && zone && staged ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-medium">Review changes</h2>
              <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
                {describeRecordChange(staged.mode, staged.change, zone.name)} Backend:{" "}
                {zone.serverName}
                {zone.cluster ? ` (cluster ${zone.cluster})` : ""}.
              </p>
            </div>
            {(() => {
              const { removed, added } = computeBindDiff(existingForKey ? [existingForKey] : [], [
                staged.change,
              ]);
              return (
                <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
                  <BareDiff removed={removed} added={added} />
                </div>
              );
            })()}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                autoFocus
                className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <SecondaryButton onClick={() => setStep("record")} disabled={saving}>
                Back
              </SecondaryButton>
            </div>
          </div>
        ) : null}

        {step === "propagation" && zone && saved ? (
          <PropagationStep
            zoneName={zone.name}
            serverSlug={saved.serverSlug}
            onFinish={() => setStep("done")}
          />
        ) : null}

        {step === "done" && zone && saved ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-success)] text-white"
                aria-hidden
              >
                <Check className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-lg font-medium">Record added</h2>
                <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
                  {staged ? describeRecordChange(staged.mode, staged.change, zone.name) : null}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href={recordsPageHref(zone.name, saved.serverSlug)}
                className="inline-flex items-center justify-center rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
              >
                Open {displayZoneName(zone.name)} records
              </Link>
              <SecondaryButton onClick={addAnother}>Add another</SecondaryButton>
              <button
                type="button"
                onClick={() => router.push("/zones")}
                className="text-sm text-[color:var(--color-fg-muted)] underline-offset-4 hover:underline sm:ml-auto"
              >
                Back to zones
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// =============================================================================
// Step pieces
// =============================================================================

function HorizonStep({
  horizons,
  value,
  onChange,
  onContinue,
}: {
  horizons: { public: number; internal: number };
  value: WizardHorizon | null;
  onChange: (next: WizardHorizon) => void;
  onContinue: () => void;
}) {
  const groupId = useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
      }}
      className="space-y-4"
    >
      <fieldset className="space-y-3">
        <legend className="text-lg font-medium">Horizon</legend>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          This installation serves both horizons. Which copy of the DNS should the record go in?
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(["public", "internal"] as const).map((h) => {
            const id = `${groupId}-${h}`;
            const selected = value === h;
            return (
              <label
                key={h}
                htmlFor={id}
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                  selected
                    ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10"
                    : "border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-subtle)]"
                }`}
              >
                <input
                  id={id}
                  type="radio"
                  name={`${groupId}-horizon`}
                  value={h}
                  checked={selected}
                  onChange={() => onChange(h)}
                  className="mt-1 accent-[color:var(--color-accent)]"
                />
                <span>
                  <span className="font-medium">{HORIZON_COPY[h].title}</span>
                  <span className="ml-2 text-xs text-[color:var(--color-fg-muted)] tabular-nums">
                    {horizons[h]} zone{horizons[h] === 1 ? "" : "s"}
                  </span>
                  <span className="mt-0.5 block text-xs text-[color:var(--color-fg-muted)]">
                    {HORIZON_COPY[h].body}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={value === null}
          className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          Continue
        </button>
        <Link
          href="/zones"
          className="text-sm text-[color:var(--color-fg-muted)] underline-offset-4 hover:underline sm:ml-auto"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function ZoneSummary({ zone, onChange }: { zone: WizardZoneHit; onChange: () => void }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[color:var(--color-fg-muted)]">
      <span>
        In{" "}
        <span className="font-mono text-[color:var(--color-fg)]">{displayZoneName(zone.name)}</span>
      </span>
      <ZoneHorizonBadge horizon={zone.horizon} />
      <span>
        on {zone.serverName}
        {zone.cluster ? ` (cluster ${zone.cluster})` : ""}
      </span>
      <button
        type="button"
        onClick={onChange}
        className="text-[color:var(--color-accent-fg)] underline-offset-4 hover:underline"
      >
        Change zone
      </button>
    </p>
  );
}

/**
 * The live "does this record exist" line under the name + type fields. Shows
 * the result only when it belongs to what is currently typed; while a check
 * is pending the previous verdict is hidden rather than left to mislead.
 */
function ExistenceStatus({
  existence,
  expectedKey,
  type,
  fqdn,
  zone,
}: {
  existence: Existence;
  expectedKey: string;
  type: string;
  fqdn: string;
  zone: WizardZoneHit;
}) {
  const [showValues, setShowValues] = useState(false);
  const valuesId = useId();
  if (existence.status === "idle") return null;
  if (existence.status === "checking" || existence.key !== expectedKey) {
    return (
      <p className="text-xs text-[color:var(--color-fg-muted)]" aria-live="polite">
        Checking {fqdn} for an existing {type} record…
      </p>
    );
  }
  if (existence.status === "error") {
    return (
      <p className="text-xs text-[color:var(--color-warn-fg)]" aria-live="polite">
        Could not check for an existing record: {existence.error} Saving will create the record.
      </p>
    );
  }
  if (!existence.rrset) {
    return (
      <p
        className="flex items-center gap-1.5 text-xs text-[color:var(--color-success-fg)]"
        aria-live="polite"
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
        Available: <span className="font-mono">{fqdn}</span> has no {type} record yet.
      </p>
    );
  }
  const rrset = existence.rrset;
  const valuesTitle = describeExistingValues(rrset);
  return (
    <div
      className="space-y-2 rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-xs"
      aria-live="polite"
    >
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-[color:var(--color-warn)]/20 px-1 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-warn-fg)] uppercase">
          exists
        </span>
        <span>
          {type} record already exists: <span className="font-mono break-all">{fqdn}</span>
        </span>
        <button
          type="button"
          title={valuesTitle}
          aria-label={`Existing ${type} values`}
          aria-expanded={showValues}
          aria-controls={valuesId}
          onClick={() => setShowValues((v) => !v)}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)]"
        >
          <Info className="h-3 w-3" aria-hidden />
        </button>
        <Link
          href={recordsPageHref(zone.name, zone.server)}
          className="text-[color:var(--color-accent-fg)] underline-offset-4 hover:underline"
        >
          edit it on the records page
        </Link>
      </p>
      {showValues ? (
        <ul id={valuesId} className="space-y-0.5 font-mono">
          {rrset.records.map((r, index) => (
            <li key={index}>
              {r.disabled ? "(disabled) " : ""}
              {r.content}
              <span className="text-[color:var(--color-fg-muted)]"> TTL {rrset.ttl}</span>
            </li>
          ))}
          {rrset.comment.trim() !== "" ? (
            <li className="font-sans text-[color:var(--color-fg-muted)]">
              Comment: {rrset.comment.trim()}
            </li>
          ) : null}
        </ul>
      ) : (
        <span id={valuesId} className="sr-only">
          {valuesTitle}
        </span>
      )}
      <p className="text-[color:var(--color-fg-muted)]">
        Saving adds your value to this RRset; the {rrset.records.length} existing{" "}
        {rrset.records.length === 1 ? "value stays" : "values stay"}.
      </p>
    </div>
  );
}

function SecondaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}
