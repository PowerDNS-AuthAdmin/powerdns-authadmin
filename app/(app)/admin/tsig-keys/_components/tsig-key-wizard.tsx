"use client";

/**
 * app/(app)/admin/tsig-keys/_components/tsig-key-wizard.tsx
 *
 * The "create / set up a TSIG key" wizard - a themed modal that replaces the old
 * always-on "add key" form + install panel. Steps:
 *
 *   1. Generate - name + algorithm (themed dropdown). PDNS mints the secret
 *      server-side; the plaintext never reaches the browser on this path.
 *   2. Install - pick a method via a themed dropdown:
 *        • Automatic (API): server pushes the secret to each secondary. No
 *          secret shown. Per-secondary outcome chips.
 *        • Manual (pdnsutil): fetch a version-agnostic copy-paste script (the
 *          secret rides back as text/plain, re-fetched server-side) to run on
 *          each box.
 *   3. Secure zones (only when the backend is a primary with zones): select the
 *      zones this key should authenticate AXFR for. Additive - never clobbers
 *      keys already on a zone.
 *
 * Re-used for an EXISTING key (skips step 1) so a key can be (re)installed after,
 * say, adding a secondary.
 */

import { useEffect, useState } from "react";
import { apiFetch, mutate } from "@/lib/client/api-fetch";
import { useDialog } from "@/components/ui/dialog";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { Checkbox } from "@/components/ui/checkbox";

export interface InstallSecondary {
  slug: string;
  name: string;
  supportsTsigApi: boolean;
}

const ALGORITHMS: Array<SelectOption<string>> = [
  { value: "hmac-sha256", label: "hmac-sha256", description: "Recommended default." },
  { value: "hmac-sha512", label: "hmac-sha512" },
  { value: "hmac-sha384", label: "hmac-sha384" },
  { value: "hmac-sha224", label: "hmac-sha224" },
  { value: "hmac-sha1", label: "hmac-sha1", description: "Legacy interop only." },
  { value: "hmac-md5", label: "hmac-md5", description: "Legacy interop only." },
];

type Method = "auto" | "manual";
const METHODS: Array<SelectOption<Method>> = [
  {
    value: "auto",
    label: "Automatic (API)",
    description: "Push the secret to each secondary's API. No secret is shown.",
  },
  {
    value: "manual",
    label: "Manual (pdnsutil)",
    description: "Copy a script (contains the secret) to run on each secondary.",
  },
];

interface InstallResult {
  serverSlug: string;
  serverName: string;
  outcome: "created" | "unchanged" | "conflict" | "unsupported" | "unreachable" | "error";
}

const OUTCOME_LABEL: Record<InstallResult["outcome"], string> = {
  created: "installed",
  unchanged: "already present",
  conflict: "conflict - different secret exists",
  unsupported: "no TSIG API (use manual)",
  unreachable: "unreachable",
  error: "failed",
};

function outcomeClass(o: InstallResult["outcome"]): string {
  if (o === "created" || o === "unchanged") return "text-[color:var(--color-success)]";
  if (o === "unsupported") return "text-[color:var(--color-fg-muted)]";
  return "text-[color:var(--color-error)]";
}

type Step = "generate" | "install" | "zones";

interface Props {
  serverSlug: string;
  secondaries: InstallSecondary[];
  /** The primary's authoritative zone names (Master/Primary) - for activation. */
  zones: string[];
  /** Set to (re)install an existing key - the wizard skips the Generate step. */
  existing?: { keyId: string; keyName: string };
  onClose: () => void;
  /** Called after a key is created so the table refreshes behind the modal. */
  onChanged: () => void;
}

export function TsigKeyWizard({
  serverSlug,
  secondaries,
  zones,
  existing,
  onClose,
  onChanged,
}: Props) {
  const { toast } = useDialog();

  const [step, setStep] = useState<Step>(existing ? "install" : "generate");
  const [key, setKey] = useState<{ id: string; name: string } | null>(
    existing ? { id: existing.keyId, name: existing.keyName } : null,
  );

  // Step 1 - generate.
  const [name, setName] = useState("");
  const [algorithm, setAlgorithm] = useState("hmac-sha256");
  const [creating, setCreating] = useState(false);

  // Step 2 - install.
  const [method, setMethod] = useState<Method>("auto");
  const [installing, setInstalling] = useState(false);
  const [results, setResults] = useState<InstallResult[] | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [loadingScript, setLoadingScript] = useState(false);

  // Step 3 - zones.
  const [selectedZones, setSelectedZones] = useState<Set<string>>(new Set());
  const [activating, setActivating] = useState(false);

  const managed = secondaries.filter((s) => s.supportsTsigApi).length;
  const path = (suffix: string) =>
    key ? `/api/admin/pdns/tsig-keys/${encodeURIComponent(key.id)}/${suffix}` : "";

  // Close on Escape + lock body scroll while open - matches the dialog system.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Manual script is fetched lazily the first time the method switches to manual.
  useEffect(() => {
    if (step !== "install" || method !== "manual" || !key || script || loadingScript) return;
    let cancelled = false;
    setLoadingScript(true);
    void apiFetch(path("manual"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSlug }),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          toast({ kind: "error", title: "Couldn't build script", description: "See server logs." });
          return;
        }
        setScript(await res.text());
      })
      .finally(() => {
        if (!cancelled) setLoadingScript(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, method, key]);

  async function generate() {
    if (!name.trim()) {
      toast({ kind: "error", description: "Enter a name." });
      return;
    }
    setCreating(true);
    try {
      const res = await mutate("/api/admin/pdns/tsig-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug, name: name.trim(), algorithm }),
      });
      if (!res.ok) {
        toast({ kind: "error", title: "Create failed", description: res.error });
        return;
      }
      const minted = (res.data as { tsigKey: { id: string; name: string } }).tsigKey;
      setKey({ id: minted.id, name: minted.name });
      onChanged();
      toast({ kind: "success", description: `Key “${minted.name}” created.` });
      setStep("install");
    } finally {
      setCreating(false);
    }
  }

  async function installAuto() {
    if (!key) return;
    setInstalling(true);
    try {
      const res = await mutate(path("install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug }),
      });
      if (!res.ok) {
        toast({ kind: "error", title: "Install failed", description: res.error });
        return;
      }
      const data = res.data as { results: InstallResult[] };
      setResults(data.results);
      const bad = data.results.filter(
        (r) => r.outcome === "conflict" || r.outcome === "unreachable" || r.outcome === "error",
      ).length;
      toast({
        kind: bad > 0 ? "error" : "success",
        title: bad > 0 ? "Installed with issues" : "Installed on secondaries",
        description:
          bad > 0
            ? `${data.results.length - bad} ok, ${bad} need attention - see below.`
            : `Replicated to ${data.results.length} secondary(ies).`,
      });
    } finally {
      setInstalling(false);
    }
  }

  async function applyZones() {
    if (!key || selectedZones.size === 0) return;
    setActivating(true);
    try {
      const targets = [...selectedZones];
      let failed = 0;
      for (const zone of targets) {
        const res = await mutate(
          `/api/admin/pdns/zones/${encodeURIComponent(zone)}/tsig-transfer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Additive - never drops other keys already securing the zone.
            body: JSON.stringify({ serverSlug, keyName: key.name, mode: "add" }),
          },
        );
        if (!res.ok) failed += 1;
      }
      toast({
        kind: failed > 0 ? "error" : "success",
        title: failed > 0 ? "Some zones failed" : "Zones secured",
        description: `${targets.length - failed}/${targets.length} zone(s) now require this key for AXFR.`,
      });
      setSelectedZones(new Set());
    } finally {
      setActivating(false);
    }
  }

  const allZonesSelected = zones.length > 0 && selectedZones.size === zones.length;
  function toggleZone(zone: string) {
    setSelectedZones((prev) => {
      const next = new Set(prev);
      if (next.has(zone)) next.delete(zone);
      else next.add(zone);
      return next;
    });
  }

  const stepNo = step === "generate" ? 1 : step === "install" ? 2 : 3;
  const totalSteps = zones.length > 0 ? 3 : 2;
  const heading =
    step === "generate"
      ? "Generate key"
      : step === "install"
        ? "Install on secondaries"
        : "Secure zones";

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative flex min-h-full items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add TSIG key"
          className="relative w-full max-w-lg rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-6 shadow-xl"
        >
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">{heading}</h2>
            <span className="text-xs text-[color:var(--color-fg-muted)]">
              Step {existing ? stepNo - 1 : stepNo} of {existing ? totalSteps - 1 : totalSteps}
            </span>
          </div>
          {key ? (
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
              Key <span className="font-mono">{key.name}</span> on{" "}
              <span className="font-mono">{serverSlug}</span>
            </p>
          ) : null}

          <div className="mt-4">
            {step === "generate" ? (
              <div className="space-y-4">
                <div>
                  <label htmlFor="wiz-tsig-name" className="block text-xs font-medium">
                    Name
                  </label>
                  <input
                    id="wiz-tsig-name"
                    type="text"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !creating) void generate();
                    }}
                    placeholder="primary-to-secondary"
                    className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div>
                  <span className="block text-xs font-medium">Algorithm</span>
                  <div className="mt-1">
                    <SelectMenu
                      value={algorithm}
                      options={ALGORITHMS}
                      onChange={setAlgorithm}
                      ariaLabel="TSIG algorithm"
                    />
                  </div>
                </div>
                <p className="text-xs text-[color:var(--color-fg-muted)]">
                  PDNS generates the HMAC secret server-side. With the automatic install you never
                  see it; choose manual to get a copy-paste script that includes it.
                </p>
              </div>
            ) : null}

            {step === "install" ? (
              <div className="space-y-4">
                <div>
                  <span className="block text-xs font-medium">Method</span>
                  <div className="mt-1">
                    <SelectMenu
                      value={method}
                      options={METHODS}
                      onChange={(m) => {
                        setMethod(m);
                        setResults(null);
                      }}
                      ariaLabel="Install method"
                    />
                  </div>
                </div>

                {method === "auto" ? (
                  <div className="space-y-2">
                    <p className="text-xs text-[color:var(--color-fg-muted)]">
                      {secondaries.length > 0
                        ? `${managed} of ${secondaries.length} secondaries support API install. The same secret is pushed to each; conflicts are reported, never overwritten.`
                        : "No app-managed secondaries - switch to manual and run the script on each box."}
                    </p>
                    {managed > 0 ? (
                      <button
                        type="button"
                        onClick={installAuto}
                        disabled={installing}
                        className="rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
                      >
                        {installing ? "Installing…" : `Install via API (${managed})`}
                      </button>
                    ) : null}
                    {results ? (
                      <ul className="space-y-0.5 text-xs">
                        {results.map((r) => (
                          <li key={r.serverSlug} className="flex items-center gap-2">
                            <span className="font-mono">{r.serverName}</span>
                            <span className={outcomeClass(r.outcome)}>
                              - {OUTCOME_LABEL[r.outcome]}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[color:var(--color-fg-muted)]">
                        Run on each secondary (contains the secret - handle carefully):
                      </span>
                      {script ? (
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard?.writeText(script)}
                          className="text-xs underline"
                        >
                          Copy
                        </button>
                      ) : null}
                    </div>
                    {loadingScript ? (
                      <p className="text-xs text-[color:var(--color-fg-muted)]">Building script…</p>
                    ) : script ? (
                      <pre className="max-h-64 overflow-auto rounded-md bg-[color:var(--color-bg-subtle)] p-3 font-mono text-[0.7rem] break-all whitespace-pre-wrap">
                        {script}
                      </pre>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            {step === "zones" ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-xs text-[color:var(--color-fg-muted)]">
                    Sets <code>master_tsig_key_ids</code> on the primary and{" "}
                    <code>slave_tsig_key_ids</code> on the secondaries that host each zone.
                  </p>
                  <Checkbox
                    checked={allZonesSelected}
                    onChange={(c) => setSelectedZones(c ? new Set(zones) : new Set())}
                    label={
                      <span className="text-xs text-[color:var(--color-fg-muted)]">
                        Select all ({zones.length})
                      </span>
                    }
                  />
                </div>
                <div className="grid max-h-56 grid-cols-1 gap-x-4 gap-y-1.5 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
                  {zones.map((z) => (
                    <Checkbox
                      key={z}
                      checked={selectedZones.has(z)}
                      onChange={() => toggleZone(z)}
                      className="min-w-0"
                      label={
                        <span className="truncate font-mono text-xs" title={z}>
                          {z}
                        </span>
                      }
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={applyZones}
                  disabled={activating || selectedZones.size === 0}
                  className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
                >
                  {activating ? "Applying…" : `Apply to selected (${selectedZones.size})`}
                </button>
              </div>
            ) : null}
          </div>

          {/* Footer navigation */}
          <div className="mt-6 flex items-center justify-end gap-3">
            {step === "generate" ? (
              <>
                <FooterGhost onClick={onClose}>Cancel</FooterGhost>
                <FooterPrimary onClick={() => void generate()} disabled={creating}>
                  {creating ? "Generating…" : "Generate & continue"}
                </FooterPrimary>
              </>
            ) : null}

            {step === "install" ? (
              <>
                <FooterGhost onClick={onClose}>Done</FooterGhost>
                {zones.length > 0 ? (
                  <FooterPrimary onClick={() => setStep("zones")}>
                    Next: secure zones →
                  </FooterPrimary>
                ) : null}
              </>
            ) : null}

            {step === "zones" ? (
              <>
                <FooterGhost onClick={() => setStep("install")}>← Back</FooterGhost>
                <FooterPrimary onClick={onClose}>Done</FooterPrimary>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function FooterPrimary({
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
      className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function FooterGhost({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
    >
      {children}
    </button>
  );
}
