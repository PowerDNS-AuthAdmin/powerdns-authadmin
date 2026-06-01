"use client";

/**
 * app/(app)/admin/users/_components/tokens-panel.tsx
 *
 * Admin view + per-row revoke of a user's API tokens. Read-only:
 * admins see metadata (name, prefix, scopes, last-used, expiry,
 * revocation state) but never the secret - token secrets are
 * Argon2-hashed and can't be recovered, even by an admin.
 *
 * Mirrors `SessionsPanel`. Date strings are pre-formatted
 * server-side and rendered inside `<span suppressHydrationWarning>`
 * (project-hydration-locale-dates memory).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { mutate } from "@/lib/client/api-fetch";

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** ISO 8601 UTC - rendered client-side via <LocalTime>. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface Props {
  userId: string;
  canManage: boolean;
  /**
   * True when the admin is looking at their own account. Tightens
   * the confirm copy. Token revocation doesn't affect the operator's
   * own session (sessions and tokens are independent credentials),
   * so the warning is informational rather than blocking - but worth
   * making explicit so the operator doesn't think "my session is
   * fine" means "scripts using this PAT are fine."
   */
  isSelf: boolean;
  tokens: TokenRow[];
}

export function TokensPanel({ userId, canManage, isSelf, tokens }: Props) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleRevoke(tokenId: string, name: string) {
    const ok = await confirm({
      title: `Revoke token "${name}"?`,
      description: isSelf
        ? "Any scripts or integrations using THIS token will start failing immediately. Your browser session is unaffected - sessions and tokens are independent credentials. Create a new token from /profile when you need API access again."
        : "Calls authenticated with this token will start failing immediately. The user can create a new token from /profile if they still need API access.",
      confirmLabel: "Revoke",
      variant: "danger",
    });
    if (!ok) return;
    setBusyId(tokenId);
    try {
      const result = await mutate(`/api/admin/users/${userId}/tokens/${tokenId}`, {
        method: "DELETE",
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Revoke failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Token revoked." });
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-md border border-[color:var(--color-border)] p-5">
      <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        API tokens ({tokens.length})
      </h2>

      {tokens.length === 0 ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">No tokens issued.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {tokens.map((t) => {
            const revoked = t.revokedAt !== null;
            return (
              <li key={t.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1 space-y-0.5 text-xs">
                  <div className="font-medium">
                    {t.name}
                    {revoked ? (
                      <span className="ml-2 rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 text-[0.6rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                        revoked
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-[color:var(--color-fg-muted)]">
                    {t.prefix}…
                  </div>
                  {t.scopes.length > 0 ? (
                    <div className="text-[color:var(--color-fg-muted)]">
                      scopes: {t.scopes.join(", ")}
                    </div>
                  ) : (
                    <div className="text-[color:var(--color-fg-muted)]">
                      scopes: (inherits user permissions)
                    </div>
                  )}
                  <div className="text-[color:var(--color-fg-subtle)]">
                    created <LocalTime ts={t.createdAt} />
                    {t.lastUsedAt ? (
                      <>
                        {" · "}
                        last used <LocalTime ts={t.lastUsedAt} />
                      </>
                    ) : (
                      <> · never used</>
                    )}
                    {t.expiresAt ? (
                      <>
                        {" · "}
                        expires <LocalTime ts={t.expiresAt} />
                      </>
                    ) : null}
                    {revoked && t.revokedAt ? (
                      <>
                        {" · "}
                        revoked <LocalTime ts={t.revokedAt} />
                      </>
                    ) : null}
                  </div>
                </div>
                {canManage && !revoked ? (
                  <button
                    type="button"
                    onClick={() => handleRevoke(t.id, t.name)}
                    disabled={busyId !== null}
                    className="shrink-0 rounded border border-[color:var(--color-error)] px-2 py-1 text-[0.6875rem] text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
                  >
                    {busyId === t.id ? "Revoking…" : "Revoke"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
