/**
 * app/api/admin/oidc-providers/route.ts
 *
 * GET  — list every OIDC provider (oidc.read).
 * POST — create a new provider (oidc.manage). The client_secret is encrypted
 *        before insert and never returned over the wire.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto/encryption";
import {
  findOidcProviderBySlug,
  insertOidcProvider,
  listAllOidcProviders,
  setOidcDiscoveryCache,
} from "@/lib/db/repositories/oidc-providers";
import { createOidcProviderSchema } from "@/lib/validators/oidc-providers";
import {
  lookupProviderTypeBySlug,
  reserveProviderSlug,
} from "@/lib/db/repositories/auth-provider-slugs";
import { probeOidcDiscovery } from "@/lib/auth/providers/oidc-probe";
import {
  assertSafeOidcIssuerUrl,
  checkOidcIssuerUrlSafe,
} from "@/lib/auth/providers/oidc-url-safety";
import { assertGroupMappingsWithinCeiling } from "@/lib/rbac/oidc-mapping-ceiling";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { logger } from "@/lib/logger";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "auth.read" });
    const rows = await listAllOidcProviders();
    // Never return the encrypted secret over the wire.
    const safe = rows.map(({ clientSecretEncrypted: _unused, ...rest }) => rest);
    return Response.json({ providers: safe }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "admin.oidc-providers.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "auth.manage" });
    await requireCsrf(request);

    let input;
    try {
      input = createOidcProviderSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const existing = await findOidcProviderBySlug(input.slug);
    if (existing) {
      throw new ConflictError(`An OIDC provider with slug "${input.slug}" already exists.`);
    }
    // Cross-type slug uniqueness: refuse to create an OIDC provider whose
    // slug is already taken by SAML or LDAP. The reservation table's PK
    // would catch this inside the transaction below too, but checking up
    // front gives the operator a clean error instead of a generic 23505.
    const existingType = await lookupProviderTypeBySlug(input.slug);
    if (existingType !== null) {
      throw new ConflictError(
        `Slug "${input.slug}" is already used by a ${existingType.toUpperCase()} provider. Slugs are unique across every authentication provider.`,
      );
    }

    // SSRF guard: the issuer is fetched server-side (probe + sign-in discovery),
    // so it must resolve to a public address (link-local/metadata always blocked).
    await assertSafeOidcIssuerUrl(input.issuerUrl);

    // Privilege ceiling (GHSA-wf29-rmhc-rqc9): group→role mappings auto-assign
    // roles at first sign-in, so they can't carry permissions the actor lacks
    // globally — otherwise `oidc.manage` would launder privilege through the IdP.
    await assertGroupMappingsWithinCeiling(user.id, input.groupMappings ?? null);

    const clientSecretEncrypted = encrypt(input.clientSecret, "oidc-client-secret");

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      // Reserve the slug in the cross-type table FIRST. The PK constraint
      // is the real guard against a concurrent insert with the same slug;
      // doing it inside the transaction means a race with another OIDC /
      // SAML / LDAP create rolls everything back atomically.
      await reserveProviderSlug({ slug: input.slug, providerType: "oidc" }, tx);
      const created = await insertOidcProvider(
        {
          slug: input.slug,
          name: input.name,
          issuerUrl: input.issuerUrl,
          clientId: input.clientId,
          clientSecretEncrypted,
          scopes: input.scopes,
          claimEmail: input.claimEmail,
          claimName: input.claimName,
          enabled: input.enabled,
          requireEmailVerified: input.requireEmailVerified,
          allowedEmailDomains: input.allowedEmailDomains ?? null,
          groupMappings: input.groupMappings ?? null,
          iconUrl: input.iconUrl ?? null,
          createdBy: user.id,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "oidc.provider.created",
          resource: { type: "oidc_provider", id: created.id },
          after: {
            slug: created.slug,
            name: created.name,
            issuerUrl: created.issuerUrl,
            clientId: created.clientId,
            scopes: created.scopes,
            claimEmail: created.claimEmail,
            claimName: created.claimName,
            enabled: created.enabled,
            requireEmailVerified: created.requireEmailVerified,
            allowedEmailDomains: created.allowedEmailDomains,
            groupMappingsCount: created.groupMappings?.length ?? 0,
            iconUrlSet: created.iconUrl !== null,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    // Best-effort first-paint probe.
    // Fires the discovery check as a detached promise so the create
    // response returns immediately; the list page reads the cache on
    // its next render. Failures are logged but don't surface as a
    // create error — the operator can re-probe via the Test button.
    void (async () => {
      try {
        // SSRF pre-check before the detached probe — defense-in-depth (the
        // pinned fetch re-checks too) and a clean transport-style failure if
        // the issuer resolves to a blocked address. Mirrors the `/test` route.
        const safety = await checkOidcIssuerUrlSafe(row.issuerUrl);
        const result = safety.safe
          ? await probeOidcDiscovery(row.issuerUrl)
          : ({ ok: false, reason: "transport" } as const);
        await setOidcDiscoveryCache(row.id, {
          fetchedAt: new Date().toISOString(),
          ok: result.ok,
          ...(result.ok ? {} : { reason: result.reason }),
        });
      } catch (err) {
        logger.warn(
          {
            provider: row.slug,
            error: err instanceof Error ? err.message : "unknown",
          },
          "oidc.provider.first-probe.failed",
        );
      }
    })();

    const { clientSecretEncrypted: _strip, ...safe } = row;
    return Response.json({ provider: safe }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.oidc-providers.route.error");
  }
}
