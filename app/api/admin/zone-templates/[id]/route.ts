/**
 * app/api/admin/zone-templates/[id]/route.ts
 *
 * PATCH  — edit (template.manage).
 * DELETE — remove (template.manage). Existing zones already created from
 *          this template are not affected — templates are a creation-time
 *          scaffold, not a live link.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import {
  deleteZoneTemplate,
  findZoneTemplateById,
  updateZoneTemplate,
} from "@/lib/db/repositories/zone-templates";
import { updateZoneTemplateSchema } from "@/lib/validators/zone-templates";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "template.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findZoneTemplateById(id);
    if (!existing) throw new NotFoundError("Zone template not found.");

    let input;
    try {
      input = updateZoneTemplateSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const patch: Parameters<typeof updateZoneTemplate>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.soaTtl !== undefined) patch.soaTtl = input.soaTtl;
    if (input.soaRefresh !== undefined) patch.soaRefresh = input.soaRefresh;
    if (input.soaRetry !== undefined) patch.soaRetry = input.soaRetry;
    if (input.soaExpire !== undefined) patch.soaExpire = input.soaExpire;
    if (input.soaMinimum !== undefined) patch.soaMinimum = input.soaMinimum;
    if (input.nameservers !== undefined) patch.nameservers = input.nameservers;
    if (input.records !== undefined) patch.records = input.records;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.soaEdit !== undefined) patch.soaEdit = input.soaEdit ?? null;
    if (input.soaEditApi !== undefined) patch.soaEditApi = input.soaEditApi ?? null;
    if (input.apiRectify !== undefined) patch.apiRectify = input.apiRectify ?? null;
    if (input.metadata !== undefined) patch.metadata = input.metadata;
    if (input.defaultForPrimaryIds !== undefined)
      patch.defaultForPrimaryIds = input.defaultForPrimaryIds;

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const row = await updateZoneTemplate(id, patch, tx);
      if (!row) throw new NotFoundError("Zone template not found.");

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "template.update",
          resource: { type: "zone_template", id },
          before: { name: existing.name, records: existing.records.length },
          after: { name: row.name, records: row.records.length },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return row;
    });

    return Response.json({ template: updated });
  } catch (err) {
    return errorResponse(err, "admin.zone-templates.id.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "template.manage" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findZoneTemplateById(id);
    if (!existing) throw new NotFoundError("Zone template not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await deleteZoneTemplate(id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "template.delete",
          resource: { type: "zone_template", id },
          before: { slug: existing.slug, name: existing.name },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.zone-templates.id.route.error");
  }
}
