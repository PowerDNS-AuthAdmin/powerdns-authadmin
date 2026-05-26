import "server-only";

/**
 * lib/request-context.ts
 *
 * Per-operation request-id context, kept in AsyncLocalStorage. Everything that
 * lands in `pdns_requests` or `audit_log` is tagged with a `requestId` so the
 * operator can pivot from "this audit row" → "the exact PDNS calls it made".
 *
 * The default source for that id is the `X-Request-Id` header that `proxy.ts`
 * injects on each incoming HTTP request, read via `next/headers`. But Next's
 * `next/headers` is itself ALS-backed and INCLUDES async tasks spawned within
 * the handler — so any `void (async () => { … })()` or background poller call
 * issued from inside a request keeps reading the *parent* request's id. That
 * leak produces the "67 PDNS calls under one request id at totally different
 * timestamps" symptom: a single user action gets attributed every poller tick,
 * background NOTIFY, and post-response cleanup the runtime happens to spawn.
 *
 * Fix: when a piece of work is genuinely a SEPARATE operation (a background
 * NOTIFY, a poller tick, a scheduled cleanup), wrap it in `withRequestId(...)`
 * with a fresh id. The PDNS http client (and the audit-append callers inside
 * the wrap) then read THIS frame's id and ignore the leaking next/headers one.
 *
 * Usage:
 *
 *   const id = newSystemRequestId();          // fresh uuid for this op
 *   void withRequestId(id, async () => {
 *     await client.notifyZone(zone);          // tagged with `id`
 *     await appendAudit({ …, request: { …, requestId: id } });
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
}

const als = new AsyncLocalStorage<RequestContext>();

/** Run `fn` inside a request-context frame with `requestId`. Calls to
 *  `currentRequestIdOverride()` inside `fn` (and any async work it spawns)
 *  return `requestId`; outside `fn` they return null. */
export function withRequestId<T>(requestId: string, fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(als.run({ requestId }, fn));
}

/** Returns the request id from the surrounding ALS frame, or `null` if not
 *  inside one. Consumers (PDNS http, audit append) should prefer this over
 *  `next/headers` so background work attributes to its own operation rather
 *  than leaking the parent route handler's id. */
export function currentRequestIdOverride(): string | null {
  return als.getStore()?.requestId ?? null;
}

/** Whether we're inside an explicit request-context frame. When `false` the
 *  PDNS http client falls back to `next/headers` (i.e. the current user
 *  request's X-Request-Id). */
export function hasRequestIdOverride(): boolean {
  return als.getStore() !== undefined;
}

/** Generate a fresh uuid for a system-initiated operation (background NOTIFY,
 *  poller tick, fire-and-forget cleanup). */
export function newSystemRequestId(): string {
  return crypto.randomUUID();
}
