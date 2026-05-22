/**
 * lib/logger.ts
 *
 * Structured logging via Pino. All logs go through this module so we have one place
 * to add correlation IDs, secret redaction, and transport configuration.
 *
 * In production logs are JSON-per-line on stdout (the twelve-factor convention),
 * suitable for collection by Vector/Fluent Bit/Loki/etc. In development we run
 * through pino-pretty for human-readable output.
 *
 * Redaction note: the configured paths below are a *baseline*. Any module handling
 * secrets must also pass them through `lib/errors/redact.ts` before including them
 * in error messages or log fields. Defense in depth.
 */

import "server-only";
import pino, { type Logger, type LoggerOptions } from "pino";
import { env, isDevelopment } from "@/lib/env";

/**
 * Build the Pino options. Kept in a function so tests can override it cleanly.
 */
function buildOptions(): LoggerOptions {
  return {
    level: env.LOG_LEVEL,

    // Stable base fields on every log line — makes log queries portable across deploys.
    base: {
      app: "powerdns-authadmin",
      // The process PID is useful for correlating logs with `top`/`ps` during incidents.
      pid: process.pid,
    },

    // ISO timestamps; epoch ms is shorter but humans can read ISO.
    timestamp: pino.stdTimeFunctions.isoTime,

    // Field-level redaction. Pino replaces matching paths with `[Redacted]` before
    // the log line is serialized. The patterns cover common header / cookie shapes
    // and our own secret-field naming.
    redact: {
      paths: [
        // HTTP request headers (case-insensitive in Pino's matcher)
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        'req.headers["set-cookie"]',
        'res.headers["set-cookie"]',
        // Common request/response body fields
        "*.password",
        "*.password_hash",
        "*.passwordHash",
        "*.token",
        "*.apiKey",
        "*.api_key",
        "*.secret",
        "*.privateKey",
        "*.private_key",
        // Env-shaped fields if ever logged as an object
        "*.APP_SECRET_KEY",
        "*.APP_ENCRYPTION_KEY",
        "*.DATABASE_URL",
        "*.REDIS_URL",
      ],
      censor: "[Redacted]",
      remove: false,
    },

    // Map error objects to readable shapes (stack, message, code) instead of
    // `Error.prototype.toString` which strips the stack.
    serializers: pino.stdSerializers,

    // Pretty-print in dev only. In prod we want raw JSON for log shippers.
    ...(isDevelopment
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              singleLine: false,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,app",
            },
          },
        }
      : {}),
  };
}

/**
 * The root logger. Use `logger.child({ ... })` to attach request-scoped context
 * (request ID, user ID, etc.) rather than logging via the root logger directly.
 */
export const logger: Logger = pino(buildOptions());

/**
 * Convenience for creating a request-scoped child logger. Call once at the start
 * of a request handler and pass the resulting logger down.
 *
 * @example
 *   const log = childLogger({ requestId, userId: user?.id });
 *   log.info({ zone: "example.com." }, "creating zone");
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
