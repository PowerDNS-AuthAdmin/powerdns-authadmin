/**
 * lib/pdns/config-advice.ts
 *
 * Renders a small read-only "Daemon settings" view from a PowerDNS daemon's
 * `/config`. (Capability-vs-config advisories now live in the health bell —
 * `lib/health/evaluator.ts`, ADR-0015 — keyed off observed capabilities, not
 * the retired `role`.)
 *
 * SECURITY: display is ALLOWLIST-only — we surface a curated set of
 * replication/operational settings and never the full config, so the
 * secret-shaped values `/config` exposes (api-key, gmysql-password, …) are
 * never rendered. A name-pattern denylist is a second line of defence.
 */

import type { PdnsConfigSetting } from "./types";

/** Settings useful to show, in display order. Secret-shaped ones (api-key) are
 *  rendered as `<redacted>`, never as plaintext — see `safeConfigSettings`. */
const DISPLAY_SETTINGS: readonly string[] = [
  "launch",
  "primary",
  "master",
  "secondary",
  "slave",
  "autosecondary",
  "superslave",
  "also-notify",
  "allow-axfr-ips",
  "allow-notify-from",
  "only-notify",
  "xfr-cycle-interval",
  "secondary-cycle-interval",
  "slave-cycle-interval",
  "api",
  "api-key",
  "webserver",
  "webserver-allow-from",
  "version-string",
  "gsqlite3-dnssec",
  "gmysql-dnssec",
  "gpgsql-dnssec",
];

/** Settings whose name smells secret — shown as `<redacted>`, never plaintext. */
const SECRET_NAME = /key|password|secret|passwd|credential/i;

/** Display token for a redacted secret value — matches the request log. */
const REDACTED = "<redacted>";

export interface SafeConfigRow {
  name: string;
  value: string;
}

function toMap(config: readonly PdnsConfigSetting[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of config) m.set(c.name.toLowerCase(), c.value);
  return m;
}

/**
 * Display-safe subset of the daemon config (the allowlist). Secret-shaped values
 * (api-key, *-password) are shown as `<redacted>` — present so the operator sees
 * the setting exists, but never the plaintext.
 */
export function safeConfigSettings(config: readonly PdnsConfigSetting[]): SafeConfigRow[] {
  const map = toMap(config);
  const out: SafeConfigRow[] = [];
  for (const name of DISPLAY_SETTINGS) {
    const value = map.get(name);
    if (value === undefined || value === "") continue;
    out.push({ name, value: SECRET_NAME.test(name) ? REDACTED : value });
  }
  return out;
}
