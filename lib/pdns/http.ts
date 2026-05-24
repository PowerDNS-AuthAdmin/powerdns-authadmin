/**
 * lib/pdns/http.ts
 *
 * Low-level HTTP transport for the PowerDNS API. Handles:
 *   - X-API-Key injection
 *   - JSON serialization
 *   - Per-request timeout via AbortController
 *   - Retries with exponential backoff on transport + 5xx errors
 *   - Telemetry (a Pino log line per request)
 *   - Error normalization through `classifyPdnsHttpError`
 *
 * The PDNS API key is "tier-0" sensitive. It NEVER appears in:
 *   - log fields (the request is logged with the URL but not the headers)
 *   - error messages (we redact the URL in case it contains user-info)
 *   - thrown error bodies (PDNS doesn't echo the key, but we redact responses
 *     as defense in depth)
 */

import "server-only";
import { fetch as undiciFetch } from "undici";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { PdnsError, PdnsUpstreamError, classifyPdnsHttpError } from "./errors";
import { pdnsDispatcher } from "./dispatcher";
import { recordPdnsLatency } from "./observations";
import { withBackendLock } from "./backend-lock";
import { checkPdnsUrlSafe } from "./url-safety";
import type { PdnsRequestLogInput } from "./request-log";

// Lazy-loaded to keep the DB layer (and pg) out of module-init for tests that
// only exercise schemas/builders. Resolved on first PDNS call.
type RecordPdnsRequest = (input: PdnsRequestLogInput) => void;
let recordPdnsRequestImpl: RecordPdnsRequest | null = null;
async function loadRecorder(): Promise<RecordPdnsRequest> {
  if (recordPdnsRequestImpl) return recordPdnsRequestImpl;
  const mod = await import("./request-log");
  recordPdnsRequestImpl = mod.recordPdnsRequest;
  return recordPdnsRequestImpl;
}

export interface PdnsHttpConfig {
  /** Root URL, no trailing slash, no `/servers/...` segment. */
  baseUrl: string;
  /** PDNS X-API-Key — already decrypted by the caller. */
  apiKey: string;
  /** Maximum attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Per-request timeout in milliseconds. Default 10s. */
  timeoutMs?: number;
  /** Slug of the backend this client talks to — included in log fields. */
  serverSlug: string;
  /**
   * Our DB row id for the backend (pdns_servers.id). Passed through to
   * `pdns_requests.server_id` so the audit-log viewer can link request
   * rows back to the server they hit. Optional because clients
   * constructed outside the registry (tests, scripts) don't have one.
   */
  serverDbId?: string;
  /**
   * Route EVERY request (not just writes) through the per-backend lock
   * (`lib/pdns/backend-lock.ts`). Set on the background-poll's probe client so
   * its reads take turns with the request path's writes instead of contending
   * on the backend's store. Interactive clients leave this off, so user reads
   * keep full concurrency; their writes still coordinate (see `pdnsRequest`).
   */
  coordinateAllRequests?: boolean;
}

export interface PdnsRequestInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path appended to `baseUrl`. Must start with "/". */
  path: string;
  /** Body to JSON-serialize. Omit for GET/DELETE. */
  body?: unknown;
  /** Operation name for telemetry, e.g. "zones.list". */
  op: string;
  /** Optional AbortSignal to cancel from above the client. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Status codes worth retrying. 408 too: PDNS rarely emits it, but the spec is clear. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Execute a request against PDNS. Returns the parsed JSON response or throws
 * a {@link PdnsError} subclass on failure.
 *
 * The transport retries up to `maxAttempts` on network errors and on
 * retryable HTTP statuses with exponential-jittered backoff. A non-retryable
 * 4xx surfaces immediately.
 */
export async function pdnsRequest<T>(config: PdnsHttpConfig, init: PdnsRequestInit): Promise<T> {
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = init.method ?? "GET";
  const url = joinUrl(config.baseUrl, init.path);
  const log = logger.child({ server: config.serverSlug, op: init.op });

  // Tie the audit row to the per-HTTP-request correlation id when we're
  // inside a request scope (route handler / Server Component). Outside
  // a request scope (background samplers, CLI scripts) `headers()`
  // throws — fall back to null silently.
  let requestId: string | null;
  try {
    const { headers: getHeaders } = await import("next/headers");
    const h = await getHeaders();
    requestId = h.get("x-request-id");
  } catch {
    requestId = null;
  }
  const logCtx = {
    requestId,
    serverDbId: config.serverDbId ?? null,
    serverSlug: config.serverSlug,
    op: init.op,
  };

  const runWithRetries = async (): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = Date.now();
      try {
        const result = await singleRequest<T>({
          url,
          method,
          body: init.body,
          apiKey: config.apiKey,
          timeoutMs,
          externalSignal: init.signal,
          log: logCtx,
        });
        const elapsed = Date.now() - start;
        recordPdnsLatency(config.serverSlug, elapsed);
        log.info({ attempt, ms: elapsed, status: 200 }, "pdns.request.ok");
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;
        // Record failures too — they still consume wall-time + their latency is
        // an early signal that the backend is hurting.
        recordPdnsLatency(config.serverSlug, elapsed);
        lastError = err;
        const retryable = isRetryable(err);
        log.warn(
          {
            attempt,
            ms: elapsed,
            retryable,
            status: err instanceof PdnsError ? err.status : 0,
            error: err instanceof Error ? redact(err.message) : "unknown",
          },
          "pdns.request.failed",
        );
        if (!retryable || attempt === maxAttempts) break;
        await sleepWithJitter(attempt);
      }
    }
    // After retries exhaust, re-throw the last error. Already classified by
    // `singleRequest` — no double-wrap.
    throw lastError;
  };

  // Coordinate per backend so the app doesn't read + write the same store at
  // once (notably gsqlite3, where a concurrent reader can stall a writer into a
  // 500). WRITES always take the lock; reads only when the caller opts in (the
  // poll's probe client) — interactive reads stay fully concurrent. Keyed by
  // the backend's DB id, falling back to its slug for registry-less clients.
  const coordinate = method !== "GET" || config.coordinateAllRequests === true;
  if (!coordinate) return runWithRetries();
  return withBackendLock(config.serverDbId ?? config.serverSlug, runWithRetries);
}

interface SingleRequestArgs {
  url: string;
  method: string;
  body: unknown;
  apiKey: string;
  timeoutMs: number;
  externalSignal: AbortSignal | undefined;
  /** Context for the `pdns_requests` audit row. */
  log: {
    requestId: string | null;
    serverDbId: string | null;
    serverSlug: string;
    op: string;
  };
}

async function singleRequest<T>(args: SingleRequestArgs): Promise<T> {
  const { url, method, body, apiKey, timeoutMs, externalSignal, log: logCtx } = args;

  /**
   * Build the outbound header map once so the audit recorder sees
   * exactly what was sent. The recorder redacts the X-API-Key entry
   * before persisting.
   */
  const outboundHeaders: Record<string, string> = {
    "X-API-Key": apiKey,
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };

  /** Fire-and-forget audit row writer. Same shape on every code path. */
  const writeAudit = (responseStatus: number | null, error: string | null) => {
    void loadRecorder().then((rec) =>
      rec({
        requestId: logCtx.requestId,
        serverDbId: logCtx.serverDbId,
        serverSlug: logCtx.serverSlug,
        op: logCtx.op,
        method,
        url,
        requestHeaders: outboundHeaders,
        requestBody: body ?? null,
        responseStatus,
        error,
      }),
    );
  };

  // DNS-rebinding defense. The hostname passed config-time safety, but DNS is
  // mutable — re-resolve immediately before the call and reject if the
  // current resolution lands in a blocked range. `checkPdnsUrlSafe` itself
  // looks up the hostname; the resolution result is intentionally NOT pinned
  // into `undici.fetch` (which performs its own lookup). Pinning would require
  // a per-request Agent with a custom `connect.lookup`, which defeats the
  // shared keep-alive connection pool (a real, per-call TLS-handshake cost).
  // Both lookups go through the OS resolver within a few ms, so a rebind
  // narrow enough to escape both is not realistic over standard cached
  // resolvers — an accepted residual risk, not an oversight. The hard
  // controls below (always-blocked metadata range + `redirect: "error"`)
  // are what actually close the SSRF vector.
  const safety = await checkPdnsUrlSafe(url);
  if (!safety.safe) {
    writeAudit(null, `Refusing to call unsafe URL: ${safety.reason}`);
    throw new PdnsUpstreamError(`Refusing to call unsafe URL: ${safety.reason}`, {
      status: 0,
    });
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  // Chain to the external signal so callers can cancel from above. AbortSignal.any
  // is available on Node 20+; we're on 22.
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(url, {
      method,
      signal,
      dispatcher: pdnsDispatcher(),
      headers: outboundHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // SSRF guard: never follow redirects. `checkPdnsUrlSafe` validates only
      // the original URL; a (compromised or hostile) endpoint returning a 3xx
      // to an internal address would otherwise be followed, bypassing the
      // allowlist. The PDNS API never legitimately redirects, so fail loud.
      redirect: "error",
    });
  } catch (err) {
    // Network/timeout/abort. Status 0 marks a transport-layer failure.
    // Surface the underlying error code (e.g. UND_ERR_SOCKET, ENOTFOUND,
    // CERT_HAS_EXPIRED) so the admin diagnostics UI can point at the
    // actual cause.
    const message = transportErrorMessage(err);
    writeAudit(null, message);
    throw new PdnsUpstreamError(redact(message), { status: 0, cause: err });
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Audit the completed request once we know the upstream status. We
  // log even on non-2xx so the change-history feed can show "this op
  // hit PDNS and got a 422" rather than silently disappearing.
  writeAudit(response.status, null);

  // 204 No Content / empty body — return undefined as the inferred T. Callers
  // typing the call as `<void>` for DELETE etc. get the right thing.
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed = parseJsonSafe(text);

  if (!response.ok) {
    const message = extractPdnsErrorMessage(parsed) ?? response.statusText;
    throw classifyPdnsHttpError(response.status, parsed, redact(message));
  }
  return parsed as T;
}

/**
 * Walk the error / .cause chain to extract the most informative line. undici
 * wraps the underlying network error as `.cause`; node's tls / dns errors
 * sometimes nest one more level. We surface "<message> (<code>)" when a code
 * is present so the admin diagnostic UI can explain failures concretely.
 */
function transportErrorMessage(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current && parts.length < 3) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: string }).code;
      parts.push(code ? `${current.message} (${code})` : current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      // A throw of something that isn't an Error is rare but possible
      // (libraries that throw plain objects or strings). Coerce to a
      // meaningful string instead of letting `String(obj)` produce the
      // useless `[object Object]` form.
      parts.push(stringifyUnknown(current));
      break;
    }
  }
  return parts.length > 0 ? parts.join(" → ") : "transport failure";
}

/**
 * Convert an arbitrary thrown / parsed value to a human-meaningful
 * string. Primitives stringify normally; objects round-trip through
 * JSON; values that fail to serialize (cycles, symbols) get a sentinel.
 */
function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? "<unserializable>";
  } catch {
    return "<unserializable>";
  }
}

function parseJsonSafe(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * PDNS error responses are commonly `{ "error": "..." }` but version-dependent
 * shapes appear. Read the obvious keys; fall back to the whole stringified body.
 */
function extractPdnsErrorMessage(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (typeof body !== "object") {
    // Numbers, booleans, bigints — fine to coerce directly without
    // tripping the no-base-to-string rule.
    return stringifyUnknown(body);
  }
  const candidate = (body as { error?: unknown; errors?: unknown }).error;
  if (typeof candidate === "string") return candidate;
  return null;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof PdnsUpstreamError) return true;
  if (err instanceof PdnsError) return RETRYABLE_STATUSES.has(err.status);
  return false;
}

/** Exponential backoff: 100ms, 300ms, 700ms, 1500ms (± 30% jitter). */
async function sleepWithJitter(attempt: number): Promise<void> {
  const baseMs = 100 * (2 ** (attempt - 1) + (attempt - 1));
  const jitter = baseMs * 0.3 * (Math.random() * 2 - 1);
  const wait = Math.max(50, Math.round(baseMs + jitter));
  await new Promise((resolve) => setTimeout(resolve, wait));
}

function joinUrl(baseUrl: string, path: string): string {
  const left = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}`;
}
