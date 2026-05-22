"use client";

/**
 * Collapsible per-operation log of the raw HTTP traffic our server sent
 * to PowerDNS while handling one request. Used both inside the change-
 * history feed's expanded row and on the audit-log viewer.
 *
 * Rendered as raw HTTP — request line + headers + body, followed by the
 * response status line. Response body is intentionally omitted (the
 * schema doesn't store it; PDNS responses are large and rarely add
 * diagnostic value over the status code).
 *
 * The `X-API-Key` header was redacted at write time; we render the
 * string PDNS' wire would have seen MINUS that secret.
 */

import Link from "next/link";
import { useState } from "react";

export interface PdnsHttpLogEntry {
  id: string;
  ts: string;
  serverSlug: string | null;
  /** Friendly server name (pdns_servers.name) at lookup time. */
  serverName: string | null;
  /** pdns_servers.id for the admin-servers detail link. */
  serverDbId: string | null;
  op: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string> | null;
  requestBody: unknown;
  responseStatus: number | null;
  error: string | null;
}

interface Props {
  entries: PdnsHttpLogEntry[];
}

export function PdnsHttpLog({ entries }: Props) {
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  const count = entries.length;
  const failures = entries.filter(
    (e) => e.error !== null || (e.responseStatus !== null && e.responseStatus >= 400),
  ).length;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="border-t border-[color:var(--color-border)]"
    >
      <summary className="cursor-pointer list-none px-4 py-2 text-[0.6875rem] text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)]">
        <span className="text-[color:var(--color-accent)]">
          {open ? "▾" : "▸"} PowerDNS HTTP requests ({count})
        </span>
        {failures > 0 ? (
          <span className="ml-2 text-[color:var(--color-error)]">{failures} failed</span>
        ) : null}
      </summary>
      <div className="space-y-3 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3">
        {entries.map((entry) => (
          <HttpBlock key={entry.id} entry={entry} />
        ))}
      </div>
    </details>
  );
}

function HttpBlock({ entry }: { entry: PdnsHttpLogEntry }) {
  const isFailure =
    entry.error !== null || (entry.responseStatus !== null && entry.responseStatus >= 400);
  return (
    <div
      className={`overflow-hidden rounded border ${
        isFailure ? "border-[color:var(--color-error)]" : "border-[color:var(--color-border)]"
      } bg-[color:var(--color-bg)]`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[color:var(--color-border)] px-3 py-1.5 text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
        <span>
          <span className="font-mono">{entry.op}</span>
          <ServerBadge entry={entry} />
        </span>
        <time className="font-mono normal-case">{entry.ts}</time>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre text-[color:var(--color-fg)]">
        {renderHttp(entry)}
      </pre>
    </div>
  );
}

function ServerBadge({ entry }: { entry: PdnsHttpLogEntry }) {
  const label = entry.serverName ?? entry.serverSlug;
  if (!label) return null;
  if (entry.serverDbId) {
    return (
      <Link
        href={`/admin/servers/${entry.serverDbId}`}
        className="ml-2 text-[color:var(--color-accent)] normal-case hover:underline"
      >
        on {label}
      </Link>
    );
  }
  return <span className="ml-2 normal-case">on {label}</span>;
}

function renderHttp(entry: PdnsHttpLogEntry): string {
  const { method, url, requestHeaders, requestBody, responseStatus, error } = entry;
  const u = safeParseUrl(url);

  const lines: string[] = [];
  // Request line — host + path so the operator sees both pieces, not
  // just the joined URL string.
  if (u) {
    lines.push(`> ${method} ${u.pathname}${u.search} HTTP/1.1`);
    lines.push(`> Host: ${u.host}`);
  } else {
    lines.push(`> ${method} ${url} HTTP/1.1`);
  }
  if (requestHeaders) {
    for (const [k, v] of Object.entries(requestHeaders)) {
      lines.push(`> ${k}: ${v}`);
    }
  }
  if (requestBody !== null && requestBody !== undefined) {
    lines.push(">");
    const body =
      typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody, null, 2);
    for (const line of body.split("\n")) lines.push(`> ${line}`);
  }

  lines.push("");
  if (error !== null) {
    lines.push(`< (transport error) ${error}`);
  } else if (responseStatus !== null) {
    lines.push(`< HTTP/1.1 ${responseStatus} ${statusText(responseStatus)}`);
  } else {
    lines.push(`< (no response recorded)`);
  }

  return lines.join("\n");
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function statusText(status: number): string {
  // Just the common ones; PDNS uses a small set.
  switch (status) {
    case 200:
      return "OK";
    case 201:
      return "Created";
    case 204:
      return "No Content";
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 412:
      return "Precondition Failed";
    case 422:
      return "Unprocessable Entity";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    case 504:
      return "Gateway Timeout";
    default:
      return "";
  }
}
