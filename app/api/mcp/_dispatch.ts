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
