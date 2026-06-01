/**
 * app/api/admin/zone-templates/route.ts
 *
 * GET  - list every template (template.use is enough to read).
 * POST - create (template.manage). All writes are audited + CSRF-guarded.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import {
  findZoneTemplateBySlug,
  insertZoneTemplate,
  listAllZoneTemplates,
} from "@/lib/db/repositories/zone-templates";
import { createZoneTemplateSchema } from "@/lib/validators/zone-templates";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "template.use" });
    const rows = await listAllZoneTemplates();
    return Response.json({ templates: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "admin.zone-templates.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "template.manage" });
    await requireCsrf(request);

    let input;
    try {
      input = createZoneTemplateSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const existing = await findZoneTemplateBySlug(input.slug);
    if (existing) {
      throw new ConflictError(`A zone template with slug "${input.slug}" already exists.`);
    }

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      const created = await insertZoneTemplate(
        {
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          soaTtl: input.soaTtl,
          soaRefresh: input.soaRefresh,
          soaRetry: input.soaRetry,
          soaExpire: input.soaExpire,
          soaMinimum: input.soaMinimum,
          nameservers: input.nameservers,
          records: input.records,
          kind: input.kind,
          soaEdit: input.soaEdit ?? null,
          soaEditApi: input.soaEditApi ?? null,
          apiRectify: input.apiRectify ?? null,
          metadata: input.metadata,
          defaultForPrimaryIds: input.defaultForPrimaryIds,
          createdBy: user.id,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "template.create",
          resource: { type: "zone_template", id: created.id },
          after: snapshot(created),
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    return Response.json({ template: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.zone-templates.route.error");
  }
}

function snapshot(row: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  soaRefresh: number;
  soaRetry: number;
  soaExpire: number;
  soaMinimum: number;
  nameservers: string[];
  records: Array<{ name: string; type: string; ttl: number; content: string }>;
}) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    soaTimers: {
      refresh: row.soaRefresh,
      retry: row.soaRetry,
      expire: row.soaExpire,
      minimum: row.soaMinimum,
    },
    nameservers: row.nameservers,
    records: row.records,
  };
}
