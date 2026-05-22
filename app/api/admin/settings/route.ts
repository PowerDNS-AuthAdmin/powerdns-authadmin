/**
 * app/api/admin/settings/route.ts
 *
 * GET   — read all known runtime-mutable app settings (settings.read).
 * PATCH — update one or more settings; passing `null` deletes the row
 *         (settings.write).
 *
 * Each known key has its own Zod validator in `lib/validators/settings.ts`.
 * Unknown keys are rejected at the boundary.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { deleteSetting, listAllSettings, upsertSetting } from "@/lib/db/repositories/settings";
import {
  KNOWN_SETTING_KEYS,
  SETTING_DEFAULTS,
  updateSettingsSchema,
  type KnownSettingKey,
} from "@/lib/validators/settings";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "settings.read" });
    const rows = await listAllSettings();
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    // Project the typed shape so the client gets defaults for missing keys.
    const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const key of KNOWN_SETTING_KEYS) {
      const value = byKey.get(key);
      if (value !== undefined) out[key] = value;
    }
    return Response.json({ settings: out }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "admin.settings.route.error");
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "settings.write" });
    await requireCsrf(request);

    let input;
    try {
      input = updateSettingsSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const hdrs = await headers();
    const auditRequest = getRequestContext(hdrs);

    // Every setting write in this request commits together with its single
    // audit row — a crash mid-loop can't leave some keys persisted and the
    // audit (or the rest of the keys) missing.
    const changed = await db.transaction(async (tx) => {
      const acc: Record<string, unknown> = {};
      for (const key of KNOWN_SETTING_KEYS) {
        if (!(key in input)) continue;
        const value = (input as Record<KnownSettingKey, unknown>)[key];
        if (value === null) {
          await deleteSetting(key, tx);
          acc[key] = null;
        } else if (value !== undefined) {
          await upsertSetting({ key, value, updatedBy: user.id }, tx);
          acc[key] = value;
        }
      }

      // No-op when the patch touched no known keys. Skip the audit row;
      // status stays 200.
      if (Object.keys(acc).length > 0) {
        await appendAudit(
          {
            actor: { type: "user", id: user.id },
            action: "settings.write",
            resource: { type: "settings", id: null },
            after: redactForAudit(acc),
            request: auditRequest,
          },
          tx,
        );
      }

      return acc;
    });

    return Response.json({ ok: true, changed: Object.keys(changed).length });
  } catch (err) {
    return errorResponse(err, "admin.settings.route.error");
  }
}

/**
 * Compress unwieldy values before they hit the audit log. A 1.5 MB data
 * URI doesn't help an auditor understand "the operator changed the brand
 * logo" — a short summary does, and keeps `audit_log.after` from
 * ballooning into a multi-megabyte row.
 */
function redactForAudit(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.startsWith("data:") && value.length > 256) {
      const mime = value.slice(5, value.indexOf(";", 5));
      out[key] = `data:${mime} (${value.length} bytes)`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
