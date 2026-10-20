/**
 * app/api/mcp/_dispatch.ts
 *
 * Every MCP write is a call into an EXISTING route handler, not a second
 * implementation. The handlers are plain functions, so we build a Request
 * that looks like the REST call a script would make and invoke them in-
 * process. `requireUser` / `appendAudit` inside them read the MCP request's
 * own headers through `next/headers`, so the bearer token, client IP and
 * user agent carry through unchanged: same RBAC ceilings, same per-RRset
 * concurrency check, same audit rows, same NOTIFY, and the audit log shows
 * the MCP client's user agent. A bearer request carries no cookies, so the
 * CSRF gate stays in its documented bearer-exempt mode.
 */

import { env } from "@/lib/env";
import { PATCH as patchRrsets } from "@/app/api/admin/pdns/zones/[zoneId]/rrsets/route";
import { POST as createZoneRoute } from "@/app/api/admin/pdns/zones/route";
import { DELETE as deleteZoneRoute } from "@/app/api/admin/pdns/zones/[zoneId]/route";
import { GET as searchZonesRoute } from "@/app/api/admin/pdns/zones/search/route";
import { GET as recordsAtRoute } from "@/app/api/admin/pdns/zones/[zoneId]/records/route";
import { GET as zoneSyncRoute } from "@/app/api/admin/pdns/zones/[zoneId]/sync/route";
import { GET as reverseReportRoute } from "@/app/api/admin/pdns/auto-ptr/report/route";
import { GET as reverseLinksRoute } from "@/app/api/admin/pdns/auto-ptr/links/route";
import { POST as reverseRectifyRoute } from "@/app/api/admin/pdns/auto-ptr/rectify/route";
import { GET as monitoringRoute } from "@/app/api/admin/monitoring/zones/route";
import { POST as monitoringRefreshRoute } from "@/app/api/admin/monitoring/zones/refresh/route";

export class DispatchError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

function forwardHeaders(incoming: Request): Headers {
  const h = new Headers({ "content-type": "application/json" });
  for (const name of ["authorization", "x-api-key", "user-agent", "x-request-id"]) {
    const v = incoming.headers.get(name);
    if (v) h.set(name, v);
  }
  return h;
}

async function unwrap(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep the raw text
  }
  if (!res.ok) throw new DispatchError(res.status, body);
  return body;
}

export interface RRsetChange {
  kind: "upsert" | "delete";
  name: string;
  type: string;
  ttl?: number;
  records?: Array<{ content: string; disabled?: boolean }>;
  comment?: string;
  /** Auto-PTR for A/AAAA (issue #164); omitted = the zone's setting. */
  ptr?: boolean;
  ptrTakeover?: boolean;
}

export async function dispatchPatchRrsets(
  incoming: Request,
  input: { zone: string; serverSlug: string; changes: RRsetChange[] },
): Promise<unknown> {
  const zoneId = encodeURIComponent(input.zone);
  const req = new Request(`${env.APP_URL}/api/admin/pdns/zones/${zoneId}/rrsets`, {
    method: "PATCH",
    headers: forwardHeaders(incoming),
    body: JSON.stringify({ serverSlug: input.serverSlug, changes: input.changes }),
  });
  return unwrap(await patchRrsets(req, { params: Promise.resolve({ zoneId }) }));
}

export async function dispatchCreateZone(incoming: Request, body: unknown): Promise<unknown> {
  const req = new Request(`${env.APP_URL}/api/admin/pdns/zones`, {
    method: "POST",
    headers: forwardHeaders(incoming),
    body: JSON.stringify(body),
  });
  return unwrap(await createZoneRoute(req));
}

export async function dispatchDeleteZone(
  incoming: Request,
  input: { zone: string; serverSlug: string },
): Promise<unknown> {
  const zoneId = encodeURIComponent(input.zone);
  const url = new URL(`${env.APP_URL}/api/admin/pdns/zones/${zoneId}`);
  url.searchParams.set("serverSlug", input.serverSlug);
  const req = new Request(url, {
    method: "DELETE",
    headers: forwardHeaders(incoming),
    body: JSON.stringify({ serverSlug: input.serverSlug }),
  });
  return unwrap(await deleteZoneRoute(req, { params: Promise.resolve({ zoneId }) }));
}

/* ------------------------------------------------------------ generic GET/POST */

type ZoneHandler = (
  req: Request,
  ctx: { params: Promise<{ zoneId: string }> },
) => Promise<Response>;
type PlainHandler = (req: Request) => Promise<Response>;

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const url = new URL(`${env.APP_URL}${path}`);
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  return url.toString();
}

/** Read-only routes: a GET with the MCP request's auth headers forwarded. */
async function dispatchGet(
  incoming: Request,
  url: string,
  handler: PlainHandler,
): Promise<unknown> {
  const req = new Request(url, { method: "GET", headers: forwardHeaders(incoming) });
  return unwrap(await handler(req));
}

async function dispatchZoneGet(
  incoming: Request,
  zone: string,
  url: string,
  handler: ZoneHandler,
): Promise<unknown> {
  const zoneId = encodeURIComponent(zone);
  const req = new Request(url, { method: "GET", headers: forwardHeaders(incoming) });
  return unwrap(await handler(req, { params: Promise.resolve({ zoneId }) }));
}

async function dispatchPost(
  incoming: Request,
  url: string,
  body: unknown,
  handler: PlainHandler,
): Promise<unknown> {
  const req = new Request(url, {
    method: "POST",
    headers: forwardHeaders(incoming),
    body: JSON.stringify(body),
  });
  return unwrap(await handler(req));
}

export function dispatchSearchZones(
  incoming: Request,
  q: { q?: string; horizon?: string; limit?: number },
): Promise<unknown> {
  return dispatchGet(
    incoming,
    withQuery("/api/admin/pdns/zones/search", {
      q: q.q,
      horizon: q.horizon,
      limit: q.limit?.toString(),
    }),
    searchZonesRoute,
  );
}

export function dispatchRecordsAt(
  incoming: Request,
  input: { zone: string; serverSlug?: string; name: string; type?: string },
): Promise<unknown> {
  const zoneId = encodeURIComponent(input.zone);
  return dispatchZoneGet(
    incoming,
    input.zone,
    withQuery(`/api/admin/pdns/zones/${zoneId}/records`, {
      serverSlug: input.serverSlug,
      name: input.name,
      type: input.type,
    }),
    recordsAtRoute,
  );
}

export function dispatchZoneSync(
  incoming: Request,
  input: { zone: string; serverSlug?: string },
): Promise<unknown> {
  const zoneId = encodeURIComponent(input.zone);
  return dispatchZoneGet(
    incoming,
    input.zone,
    withQuery(`/api/admin/pdns/zones/${zoneId}/sync`, { serverSlug: input.serverSlug }),
    zoneSyncRoute,
  );
}

export function dispatchReverseReport(incoming: Request, refresh: boolean): Promise<unknown> {
  return dispatchGet(
    incoming,
    withQuery("/api/admin/pdns/auto-ptr/report", { refresh: refresh ? "1" : undefined }),
    reverseReportRoute,
  );
}

export function dispatchReverseLinks(
  incoming: Request,
  input: { zone: string; serverSlug?: string },
): Promise<unknown> {
  return dispatchGet(
    incoming,
    withQuery("/api/admin/pdns/auto-ptr/links", { zone: input.zone, serverSlug: input.serverSlug }),
    reverseLinksRoute,
  );
}

export function dispatchReverseRectify(incoming: Request, body: unknown): Promise<unknown> {
  return dispatchPost(
    incoming,
    `${env.APP_URL}/api/admin/pdns/auto-ptr/rectify`,
    body,
    reverseRectifyRoute,
  );
}

export function dispatchMonitoring(incoming: Request): Promise<unknown> {
  return dispatchGet(incoming, `${env.APP_URL}/api/admin/monitoring/zones`, monitoringRoute);
}

export function dispatchMonitoringRefresh(incoming: Request, body: unknown): Promise<unknown> {
  return dispatchPost(
    incoming,
    `${env.APP_URL}/api/admin/monitoring/zones/refresh`,
    body,
    monitoringRefreshRoute,
  );
}
