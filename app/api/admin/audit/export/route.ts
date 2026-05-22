/**
 * app/api/admin/audit/export/route.ts
 *
 * GET — export audit rows matching the same query-string filters the
 * admin page accepts, as RFC 4180 CSV. Capped at 10,000 rows (the
 * pragmatic ceiling for a single browser download); narrower
 * filters get fewer rows. Audit row itself is appended to record
 * who exported what — exports are themselves a security-relevant
 * action and operators should be able to see them in the log.
 *
 * Gate: `audit.read`. No CSRF — this is a GET (idempotent / cache-
 * safe-by-method), accessible by direct URL for sharing.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { rowsToCsv } from "@/lib/audit/csv";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { listAuditForExport } from "@/lib/db/repositories/audit";
import { auditQuerySchema } from "@/lib/validators/audit";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/errors";

export async function GET(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "audit.read" });

    const url = new URL(request.url);
    const flat: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      if (typeof v === "string" && v !== "") flat[k] = v;
    }

    const parsed = auditQuerySchema.safeParse(flat);
    if (!parsed.success) {
      throw new ValidationError("Invalid filters in URL.", {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const filters = parsed.data;

    // Same end-of-day bump as the page: a bare-date `to` means
    // "through end of that day in UTC."
    const TO_END_OF_DAY_BUMP_MS = 24 * 60 * 60 * 1000;
    const isBareDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const toDate = filters.to
      ? new Date(
          isBareDate(filters.to)
            ? new Date(filters.to).getTime() + TO_END_OF_DAY_BUMP_MS
            : filters.to,
        )
      : undefined;

    const rows = await listAuditForExport({
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.actorType ? { actorType: filters.actorType } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
      ...(filters.requestId ? { requestId: filters.requestId } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.from ? { from: new Date(filters.from) } : {}),
      ...(toDate ? { to: toDate } : {}),
    });

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "audit.export",
      resource: { type: "audit", id: null },
      after: {
        rows: rows.length,
        // Capture the filter set verbatim so operators reviewing the
        // log later know exactly what slice was exported. Skip
        // empties to keep the row small.
        filters: Object.fromEntries(Object.entries(flat).filter(([, v]) => v !== "")),
      },
      request: getRequestContext(hdrs),
    });

    const filename = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(rowsToCsv(rows), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof ValidationError)
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
