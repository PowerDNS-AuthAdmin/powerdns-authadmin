"use client";

/**
 * Audit-log filter form. Replaces the legacy `<form method="get">`
 * that triggered a full page navigation on Apply - the navigation
 * dropped the app-wide SSE connection, flashing the Live chip
 * through offline → connecting → live every time. This form pushes
 * the filter state into the URL via `router.replace({scroll:false})`
 * which re-runs the server component WITHOUT a full nav.
 *
 * State is controlled - every keystroke is captured locally and
 * only committed to the URL on Apply (so each keystroke doesn't
 * thrash the server with a re-render).
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { SelectMenu } from "@/components/ui/select-menu";

interface ActionGroup {
  ns: string;
  actions: readonly string[];
}

interface Props {
  initial: {
    action: string;
    actorType: string;
    resourceType: string;
    actorId: string;
    resourceId: string;
    requestId: string;
    q: string;
    /** ISO datetime strings (UTC). */
    from: string;
    to: string;
  };
  actionGroups: ActionGroup[];
  hasFilters: boolean;
}

export function AuditFilterForm({ initial, actionGroups, hasFilters }: Props) {
  const router = useRouter();

  const [action, setAction] = useState(initial.action);
  const [actorType, setActorType] = useState(initial.actorType);
  const [resourceType, setResourceType] = useState(initial.resourceType);
  const [actorId, setActorId] = useState(initial.actorId);
  const [resourceId, setResourceId] = useState(initial.resourceId);
  const [requestId, setRequestId] = useState(initial.requestId);
  const [q, setQ] = useState(initial.q);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);

  // Sync the inputs with the URL: when an outside link populates query params
  // (e.g. clicking a `req:` link on a row, or a quick-filter chip) the page
  // re-renders with a new `initial`, but useState only takes the first value.
  // Without this the inputs stay blank even though the URL is filtered - the
  // operator can't see WHAT they're filtered to.
  const initialKey = JSON.stringify(initial);
  useEffect(() => {
    setAction(initial.action);
    setActorType(initial.actorType);
    setResourceType(initial.resourceType);
    setActorId(initial.actorId);
    setResourceId(initial.resourceId);
    setRequestId(initial.requestId);
    setQ(initial.q);
    setFrom(initial.from);
    setTo(initial.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (actorType) params.set("actorType", actorType);
    if (resourceType) params.set("resourceType", resourceType);
    if (actorId) params.set("actorId", actorId);
    if (resourceId) params.set("resourceId", resourceId);
    if (requestId) params.set("requestId", requestId);
    if (q) params.set("q", q);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    router.replace(`/admin/audit${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  function clear() {
    setAction("");
    setActorType("");
    setResourceType("");
    setActorId("");
    setResourceId("");
    setRequestId("");
    setQ("");
    setFrom("");
    setTo("");
    router.replace("/admin/audit", { scroll: false });
  }

  return (
    <form
      onSubmit={apply}
      className="grid gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-xs sm:grid-cols-3"
    >
      <Field label="Action">
        <SelectMenu
          value={action}
          onChange={setAction}
          placeholder="All actions"
          ariaLabel="Action"
          className="w-full text-xs"
          options={actionGroups.flatMap((g) =>
            g.actions.map((a) => ({ value: a, label: a, description: g.ns })),
          )}
        />
      </Field>
      <Field label="Actor type">
        <SelectMenu
          value={actorType}
          onChange={setActorType}
          placeholder="Any"
          ariaLabel="Actor type"
          className="w-full text-xs"
          options={[
            { value: "user", label: "user" },
            { value: "token", label: "token" },
            { value: "system", label: "system" },
          ]}
        />
      </Field>
      <Field label="Resource type">
        <input
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
          placeholder="e.g. user, pdns_server"
          className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
        />
      </Field>
      <Field label="Actor id (UUID)">
        <input
          value={actorId}
          onChange={(e) => setActorId(e.target.value)}
          className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field label="Resource id">
        <input
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
          className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field label="Request id">
        <input
          value={requestId}
          onChange={(e) => setRequestId(e.target.value)}
          placeholder="From a log line or error toast"
          className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field label="Search (action / resource / before / after)" colSpan={3}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. example.com, captcha-failed, 169.254"
          className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 font-mono text-xs"
        />
      </Field>
      <Field label="From">
        <DateTimePicker
          value={from}
          onChange={setFrom}
          side="from"
          className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
        />
      </Field>
      <Field label="To">
        <DateTimePicker
          value={to}
          onChange={setTo}
          side="to"
          className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1 text-xs"
        />
      </Field>
      <div className="flex items-end gap-2 sm:col-span-3">
        <button
          type="submit"
          className="rounded bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
        >
          Apply
        </button>
        {hasFilters ? (
          <button
            type="button"
            onClick={clear}
            className="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
          >
            Clear
          </button>
        ) : null}
      </div>
    </form>
  );
}

function Field({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan?: 2 | 3;
  children: React.ReactNode;
}) {
  const col = colSpan === 3 ? "sm:col-span-3" : colSpan === 2 ? "sm:col-span-2" : "";
  return (
    <label className={`space-y-1 ${col}`}>
      <span className="block text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}
