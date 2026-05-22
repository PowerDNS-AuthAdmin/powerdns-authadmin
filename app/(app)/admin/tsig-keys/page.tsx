/**
 * app/(app)/admin/tsig-keys/page.tsx
 *
 * Per-backend inventory of TSIG keys. Lists name + algorithm only —
 * **never** the shared-secret material, which is reserved for a
 * future reveal flow gated on `tsig.manage`.
 *
 * Permission: `tsig.read`. Operators with `tsig.manage` additionally
 * see (in a later tick) buttons to reveal a key's secret, generate
 * a new key, and delete keys.
 *
 * Backend selection: pass `?server=<slug>` to inspect a non-default
 * backend (matches the convention used by the zones list and
 * /admin/servers detail pages).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import {
  findDefaultPdnsServer,
  findPdnsServerBySlug,
  listAllPdnsServers,
} from "@/lib/db/repositories/pdns-servers";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { TsigActions } from "./_components/tsig-actions";

export const metadata: Metadata = { title: "TSIG keys" };

interface PageProps {
  searchParams: Promise<{ server?: string }>;
}

export default async function TsigKeysPage({ searchParams }: PageProps) {
  const { ability } = await requireUserForPage({ can: "tsig.read" });
  const canManage = ability.can("manage", "Tsig");
  const { server: requestedSlug } = await searchParams;

  const selected = requestedSlug
    ? await findPdnsServerBySlug(requestedSlug)
    : await findDefaultPdnsServer();
  const servers = await listAllPdnsServers();

  if (selected?.disabledAt !== null) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">TSIG keys</h1>
        </header>
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-6 text-sm">
          <strong>No backend selected.</strong> Add a server under{" "}
          <Link href="/admin/servers" className="underline">
            /admin/servers
          </Link>{" "}
          first.
        </div>
      </div>
    );
  }

  let keys: Awaited<ReturnType<typeof loadKeys>> | null = null;
  let fetchError: string | null = null;
  try {
    keys = await loadKeys(selected);
  } catch (err) {
    fetchError = err instanceof Error ? redact(err.message) : "Unknown error";
    logger.warn({ server: selected.slug, err: fetchError }, "admin.tsig.list.failed");
  }

  const sorted = keys ? [...keys].sort((a, b) => a.name.localeCompare(b.name)) : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">TSIG keys</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Shared HMAC secrets used to authenticate AXFR / IXFR / NOTIFY between primaries and
          secondaries. The secret material is never shown on this page.
        </p>
      </header>

      {servers.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-xs">
          {servers
            .filter((s) => s.disabledAt === null)
            .map((s) => (
              <Link
                key={s.id}
                href={`/admin/tsig-keys?server=${encodeURIComponent(s.slug)}`}
                className={
                  s.slug === selected.slug
                    ? "rounded border border-[color:var(--color-accent)] bg-[color:var(--color-accent)] px-2 py-1 text-[color:var(--color-accent-fg)]"
                    : "rounded border border-[color:var(--color-border)] px-2 py-1 hover:bg-[color:var(--color-bg-muted)]"
                }
              >
                {s.name}
              </Link>
            ))}
        </nav>
      ) : null}

      {fetchError ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm">
          <strong>Could not list TSIG keys.</strong>
          <p className="mt-1 text-xs">{fetchError}</p>
        </div>
      ) : null}

      {sorted?.length === 0 ? (
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5 text-sm">
          No TSIG keys configured on <code>{selected.slug}</code>. AXFR and NOTIFY between this
          backend and its peers happens without shared-secret authentication.
        </div>
      ) : null}

      {canManage ? (
        <TsigActions serverSlug={selected.slug} rows={sorted ?? []} />
      ) : sorted && sorted.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Algorithm</th>
                <th className="px-4 py-2 font-mono text-[0.625rem] normal-case">id</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((k) => (
                <tr key={k.id} className="border-t border-[color:var(--color-border)]">
                  <td className="px-4 py-3 font-mono text-xs">{k.name}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-[color:var(--color-bg-muted)] px-2 py-0.5 font-mono text-xs">
                      {k.algorithm}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[0.625rem] text-[color:var(--color-fg-muted)]">
                    {k.id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

async function loadKeys(selected: Awaited<ReturnType<typeof findDefaultPdnsServer>> & object) {
  const client = getPdnsClientForRow(selected);
  return client.listTsigKeys();
}
