/**
 * app/api/admin/pdns/autoprimaries/route.ts
 *
 * POST   - register a (ip, nameserver, account?) tuple.
 *          Permission: `autoprimary.manage`.
 * DELETE - remove a tuple by (ip, nameserver) - passed as query
 *          params because they're the compound key.
 *          Permission: `autoprimary.manage`.
 *
 * Audit captures the full tuple on both paths. Autoprimaries
 * include no secret material, so no field needs redaction.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { PdnsConflictError } from "@/lib/pdns/errors";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const ipShape = z
  .string()
  .min(1)
  .max(45)
  .regex(/^[0-9a-fA-F:.]+$/, "Must be an IPv4 or IPv6 address.");

const nameserverShape = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9.-]+\.?$/, "Must be a hostname.");

const createSchema = z.object({
  serverSlug: z.string().optional(),
  ip: ipShape,
  nameserver: nameserverShape,
  account: z.string().max(64).optional(),
});

const deleteQuerySchema = z.object({
  serverSlug: z.string().optional(),
  ip: ipShape,
  nameserver: nameserverShape,
});

export async function POST(request: Request): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "autoprimary.manage" });
    await requireCsrf(request);

    let body;
    try {
      body = createSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const selected = await resolveServer(body.serverSlug);
    const client = getBackendGateway(selected);

    const payload = {
      ip: body.ip,
      nameserver: body.nameserver,
      ...(body.account ? { account: body.account } : {}),
    };
    try {
      await client.createAutoprimary(payload);
    } catch (err) {
      if (err instanceof PdnsConflictError) {
        throw new ConflictError("An autoprimary with that ip + nameserver already exists.");
      }
      throw err;
    }

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "autoprimary.create",
      resource: { type: "pdns-server", id: selected.id },
      after: payload,
      request: getRequestContext(hdrs),
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "autoprimary.create");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "autoprimary.manage" });
    await requireCsrf(request);

    const url = new URL(request.url);
    let parsed;
    try {
      parsed = deleteQuerySchema.parse(Object.fromEntries(url.searchParams));
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid query.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const selected = await resolveServer(parsed.serverSlug);
    const client = getBackendGateway(selected);

    await client.deleteAutoprimary({
      ip: parsed.ip,
      nameserver: parsed.nameserver,
    });

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "autoprimary.delete",
      resource: { type: "pdns-server", id: selected.id },
      before: { ip: parsed.ip, nameserver: parsed.nameserver },
      after: null,
      request: getRequestContext(hdrs),
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "autoprimary.delete");
  }
}

async function resolveServer(slug: string | undefined) {
  const selected = slug ? await findPdnsServerBySlug(slug) : await findDefaultPdnsServer();
  if (selected?.disabledAt !== null) {
    throw new NotFoundError("No PDNS backend selected.");
  }
  return selected;
}
