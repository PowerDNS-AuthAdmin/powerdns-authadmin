"use client";

/**
 * app/(app)/admin/users/_components/user-actions.tsx
 *
 * Edit-name + status + force-reset + delete buttons for the user detail
 * page. Calls the admin user routes and refreshes the page after writes.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

interface UserActionsProps {
  userId: string;
  initialName: string;
  disabled: boolean;
  mustChangePassword: boolean;
  ssoOnly: boolean;
  canUpdate: boolean;
  canReset: boolean;
  canDelete: boolean;
  isSelf: boolean;
  /**
   * This row is the RO-locked demo bootstrap admin. The caller already folds
   * the lock into canUpdate/canReset/canDelete (so the buttons hide); this flag
   * just lets us explain why instead of showing an empty Actions box.
   */
  readonlyDemo: boolean;
}

export function UserActions(props: UserActionsProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [name, setName] = useState(props.initialName);
  const [savingName, setSavingName] = useState(false);
  const [togglingDisabled, setTogglingDisabled] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    const res = await apiFetch(`/api/admin/users/${props.userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "Update failed.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function handleSaveName() {
    setSavingName(true);
    try {
      await patch({ name: name === "" ? null : name });
    } finally {
      setSavingName(false);
    }
  }

  async function handleToggleDisabled() {
    if (props.isSelf) {
      setError("You cannot disable your own account.");
      return;
    }
    const ok = await confirm({
      title: props.disabled ? "Enable this account?" : "Disable this account?",
      description: props.disabled
        ? "The user will be able to sign in again."
        : "The user's active sessions will be revoked immediately and they won't be able to sign in until re-enabled.",
      confirmLabel: props.disabled ? "Enable" : "Disable",
      variant: props.disabled ? "default" : "danger",
    });
    if (!ok) return;
    setTogglingDisabled(true);
    try {
      const success = await patch({ disabled: !props.disabled });
      if (success) {
        toast({
          kind: "success",
          description: props.disabled ? "Account enabled." : "Account disabled.",
        });
      }
    } finally {
      setTogglingDisabled(false);
    }
  }

  async function handleReset() {
    const ok = await confirm({
      title: "Reset password?",
      description:
        "A new temporary password will be generated and shown once. The user's active sessions will be revoked.",
      confirmLabel: "Generate new password",
      variant: "danger",
    });
    if (!ok) return;
    setResetting(true);
    setError(null);
    setResetResult(null);
    try {
      const res = await apiFetch(`/api/admin/users/${props.userId}/reset-password`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const msg = data?.error ?? "Reset failed.";
        setError(msg);
        toast({ kind: "error", title: "Reset failed", description: msg });
        return;
      }
      // The POST no longer carries the plaintext (S-8). It hands back a
      // single-use token; we redeem it via the reveal endpoint, which
      // returns text/plain. The token is bound server-side to this
      // operator's session and to a short TTL.
      const minted = (await res.json()) as {
        revealToken: string;
        expiresInSec: number;
      };
      const revealRes = await apiFetch(`/api/admin/users/${props.userId}/reset-password/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: minted.revealToken }),
      });
      if (!revealRes.ok) {
        const data = (await revealRes.json().catch(() => null)) as {
          error?: string;
        } | null;
        const msg =
          data?.error ?? "Password reset, but the one-time reveal failed. Re-run the reset.";
        setError(msg);
        toast({ kind: "error", title: "Reveal failed", description: msg });
        router.refresh();
        return;
      }
      const plaintext = await revealRes.text();
      setResetResult(plaintext);
      toast({
        kind: "success",
        description: "Password reset. Temp password shown below.",
      });
      router.refresh();
    } finally {
      setResetting(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete this user?",
      description:
        "Sessions and role assignments cascade. Audit history is preserved. This cannot be undone.",
      confirmLabel: "Delete user",
      variant: "danger",
      dismissOnBackdrop: false,
    });
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/users/${props.userId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const msg = data?.error ?? "Delete failed.";
        setError(msg);
        toast({ kind: "error", title: "Delete failed", description: msg });
        return;
      }
      toast({ kind: "success", description: "User deleted." });
      router.push("/admin/users");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-[color:var(--color-border)] p-5">
      <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        Actions
      </h2>

      {props.readonlyDemo ? (
        <p className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-2.5 text-xs text-[color:var(--color-fg-muted)]">
          This is the shared, read-only demo account. Its identity, credentials, roles, and status
          are locked and can&apos;t be changed.
        </p>
      ) : null}

      {props.canUpdate ? (
        <div className="space-y-2">
          <label htmlFor="user-name" className="block text-sm font-medium">
            Display name
          </label>
          <div className="flex items-center gap-3">
            <input
              id="user-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSaveName}
              disabled={savingName || name === props.initialName}
              className="rounded-md border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
            >
              {savingName ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {props.canUpdate ? (
          <button
            type="button"
            onClick={handleToggleDisabled}
            disabled={togglingDisabled || props.isSelf}
            className="rounded-md border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
            title={props.isSelf ? "You can't disable your own account" : undefined}
          >
            {props.disabled ? "Enable account" : "Disable account"}
          </button>
        ) : null}

        {props.canReset && !props.ssoOnly ? (
          <button
            type="button"
            onClick={handleReset}
            disabled={resetting}
            className="rounded-md border border-[color:var(--color-border)] px-3 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
          >
            {resetting ? "Resetting…" : "Reset password"}
          </button>
        ) : null}

        {props.canDelete ? (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="ml-auto rounded-md border border-[color:var(--color-error)] px-3 py-2 text-sm text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete user"}
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-3 text-sm text-[color:var(--color-error)]">
          {error}
        </div>
      ) : null}

      {resetResult ? (
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-sm">
          <p className="font-medium">Temporary password</p>
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
            Shown once. Convey to the user out-of-band; they&apos;ll be forced to change it on next
            sign-in.
          </p>
          <code className="mt-2 block rounded bg-[color:var(--color-bg)] p-2 font-mono text-sm break-all">
            {resetResult}
          </code>
        </div>
      ) : null}
    </section>
  );
}
