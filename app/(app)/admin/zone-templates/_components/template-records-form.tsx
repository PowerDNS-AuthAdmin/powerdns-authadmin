"use client";

/**
 * Per-template Records editor (nameservers + prelude records). Each save
 * PATCHes only those two fields so independent tab edits don't clobber
 * zone-settings or metadata edits made elsewhere on the template.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";
import { SUPPORTED_TYPES, getRRTypeValidator } from "@/lib/validators/rr-types";
import { NumberInput } from "@/app/(app)/zones/[zoneId]/_components/number-input";
import { SelectMenu } from "@/components/ui/select-menu";

interface TemplateRecord {
  name: string;
  type: string;
  ttl: number;
  content: string;
  disabled?: boolean;
}

interface Props {
  templateId: string;
  initial: { nameservers: string[]; records: TemplateRecord[] };
  canEdit: boolean;
}

export function TemplateRecordsForm({ templateId, initial, canEdit }: Props) {
  const router = useRouter();
  const { toast } = useDialog();
  const [nameservers, setNameservers] = useState<string[]>(initial.nameservers);
  const [records, setRecords] = useState<TemplateRecord[]>(initial.records);
  const [saving, setSaving] = useState(false);

  const dirty =
    JSON.stringify(nameservers) !== JSON.stringify(initial.nameservers) ||
    JSON.stringify(records) !== JSON.stringify(initial.records);

  function setNs(i: number, value: string) {
    setNameservers(nameservers.map((n, idx) => (idx === i ? value : n)));
  }
  function setRecord(i: number, patch: Partial<TemplateRecord>) {
    setRecords(records.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const cleanNs = nameservers.map((n) => n.trim()).filter((n) => n !== "");
      const cleanRecords = records
        .map((r) => ({
          name: r.name.trim() || "@",
          type: r.type.toUpperCase(),
          ttl: r.ttl,
          content: r.content.trim(),
          ...(r.disabled ? { disabled: true } : {}),
        }))
        .filter((r) => r.content !== "");

      const result = await mutate(`/api/admin/zone-templates/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nameservers: cleanNs, records: cleanRecords }),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Save failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Records saved." });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Default nameservers
        </h3>
        <p className="mb-3 text-xs text-[color:var(--color-fg-muted)]">
          Seeded as NS records on the zone apex when a zone is created from this template.
        </p>
        <div className="space-y-2">
          {nameservers.length === 0 ? (
            <p className="text-xs text-[color:var(--color-fg-muted)]">No defaults configured.</p>
          ) : null}
          {nameservers.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={n}
                onChange={(e) => setNs(i, e.target.value)}
                disabled={!canEdit}
                placeholder="ns1.example.net."
                className={inputClass + " flex-1 font-mono"}
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => setNameservers(nameservers.filter((_, idx) => idx !== i))}
                  className="text-xs text-[color:var(--color-error)] hover:underline"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          {canEdit ? (
            <button
              type="button"
              onClick={() => setNameservers([...nameservers, ""])}
              className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-subtle)]"
            >
              Add nameserver
            </button>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Prelude records
        </h3>
        <p className="mb-3 text-xs text-[color:var(--color-fg-muted)]">
          Records added to every new zone after the SOA + NS. Use relative names: <code>@</code> for
          the zone apex, <code>www</code> for www.&lt;zone&gt;, etc.
        </p>
        <div className="space-y-3">
          {records.length === 0 ? (
            <p className="text-xs text-[color:var(--color-fg-muted)]">
              No prelude records — zones from this template start with just SOA + NS.
            </p>
          ) : null}
          {records.map((r, i) => {
            const validator = getRRTypeValidator(r.type);
            const issues = r.content.trim() === "" ? [] : validator.validate(r.content).issues;
            return (
              <div
                key={i}
                className="space-y-2 rounded-md border border-[color:var(--color-border)] p-3"
              >
                <div className="grid gap-2 sm:grid-cols-[1fr_120px_120px_auto]">
                  <input
                    value={r.name}
                    onChange={(e) => setRecord(i, { name: e.target.value })}
                    disabled={!canEdit}
                    placeholder="@"
                    className={inputClass + " font-mono"}
                  />
                  <SelectMenu
                    value={r.type}
                    onChange={(v) => setRecord(i, { type: v, content: "" })}
                    disabled={!canEdit}
                    ariaLabel="Record type"
                    options={SUPPORTED_TYPES.map((t) => ({ value: t, label: t }))}
                    className="w-full text-xs"
                  />
                  <NumberInput
                    value={r.ttl}
                    onChange={(n) => setRecord(i, { ttl: n })}
                    min={0}
                    disabled={!canEdit}
                    className={inputClass + " font-mono"}
                  />
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => setRecords(records.filter((_, idx) => idx !== i))}
                      className="text-xs text-[color:var(--color-error)] hover:underline"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  value={r.content}
                  onChange={(e) => setRecord(i, { content: e.target.value })}
                  disabled={!canEdit}
                  placeholder={validator.placeholder}
                  className={inputClass + " font-mono"}
                />
                {issues.length > 0 ? (
                  <ul className="space-y-0.5 text-xs">
                    {issues.map((issue, idx) => (
                      <li
                        key={idx}
                        className={
                          issue.level === "error"
                            ? "text-[color:var(--color-error)]"
                            : "text-[color:var(--color-warn)]"
                        }
                      >
                        <span className="font-medium uppercase">{issue.level}</span> {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
          {canEdit ? (
            <button
              type="button"
              onClick={() =>
                setRecords([...records, { name: "@", type: "A", ttl: 3600, content: "" }])
              }
              className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-subtle)]"
            >
              Add record
            </button>
          ) : null}
        </div>
      </div>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save records"}
          </button>
          {!dirty ? (
            <span className="text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              No unsaved changes
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const inputClass =
  "block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-60";
