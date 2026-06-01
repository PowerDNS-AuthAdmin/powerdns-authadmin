# 12. First-boot provisioning + OIDC group → role materialisation

Date: 2026-05-18

## Status

Accepted.

## Context

Stand-up is the most under-served part of the operator experience. Today, an
operator with a fresh PowerDNS-AuthAdmin install has to:

1. Run `docker compose up`.
2. Sign in as the bootstrap admin from `BOOTSTRAP_ADMIN_*` env.
3. Click through the admin UI to add their OIDC provider.
4. Click through to add each PDNS backend (primary + every secondary).
5. Click through to add zone templates.
6. Set runtime settings (brand, site name, lockout policy).
7. Manually assign roles to every user as they trickle in via OIDC, since
   we have no group→role mapping today.

Steps 3–7 are repeatable across every fresh install of an org - they're
declarative configuration, not per-instance state. They belong in source
control next to the rest of the deployment manifest.

The certifi project (sister project, same operator) shipped a
`provisioning.example.yaml` for the same shape of problem. It works well
in production. PowerDNS-AuthAdmin can adopt the same pattern wholesale with
local adaptations for the bigger surface area (PDNS primaries+secondaries,
multi-provider OIDC, zone templates).

## Decision

### Provisioning file

`PROVISIONING_FILE` env points at a YAML file that is read and applied on
first boot. The applier is idempotent:

- Every entry is upserted on its slug (or KV key for settings).
- A `provisioned_at` row is written to the `settings` table after a
  successful apply. Subsequent restarts see the sentinel and skip the file.
- An operator force-re-applies by deleting the sentinel row and restarting.

The file is parsed by Zod with `.strict()` on every section - typos in
top-level keys or section entries abort startup with a precise error rather
than silently becoming a no-op.

Run trigger: `docker/entrypoint.mjs` calls `node scripts/provision.js` after
migrations and before launching the Next.js server. `PROVISION_ON_BOOT=false`
opts out (operators using an out-of-band provisioning workflow).

### Sections covered

- `settings` - KV writes against the known-keys vocabulary in
  `lib/validators/settings.ts`.
- `roles` - custom roles only; system roles stay in `scripts/seed.ts`.
- `teams` - teams as DB rows. Members come from OIDC group mappings, not
  the YAML - keeping plaintext-password users out of the file is a
  deliberate scope choice.
- `zone_templates` - applied to new zones at create time.
- `pdns_servers` - primaries + secondaries. Secondaries reference their
  primary by slug; resolution happens at apply time.
- `oidc` - providers + their group→role mappings.

### OIDC group → role materialisation

Two schema additions (single migration each for PG + SQLite):

- `oidc_providers.group_mappings` - JSON array of
  `{ group, roleSlug, scopeType, scopeId }`. Provisioning resolves
  team/server slug references to ids at write time; zone scope is a
  literal name (no FK).
- `role_assignments.provider_id` - nullable FK to `oidc_providers`,
  `ON DELETE SET NULL`. Set ONLY by the OIDC sign-in materialiser;
  admin-issued assignments stay NULL.

At every successful OIDC sign-in (`app/api/auth/oidc/[provider]/callback`):

1. Read the user's groups claim (`claim_groups`, default `"groups"`).
2. Filter `provider.groupMappings` to mappings whose `group` appears.
3. Resolve each filtered mapping to a `(roleId, scopeType, scopeId)`
   tuple. Mappings whose role slug is unknown are skipped + audited
   (`auth.oidc.group_sync.mapping_unresolved`).
4. Load existing role assignments where `provider_id = provider.id`.
5. Diff: ADD new tuples; REMOVE tuples no longer in the target set.
6. Audit every ADD/REMOVE individually.

Properties:

- **Admin-issued assignments are never touched.** They have
  `provider_id IS NULL` and the diff query filters by `provider_id =
provider.id`.
- **Group-membership churn is reflected on the next sign-in.** A user
  removed from a group on the IdP loses their role on their next
  sign-in. Until then they keep the role - we don't push from the IdP.
- **Failure is non-fatal.** A group-sync failure logs + audits but
  doesn't block the sign-in itself - the user's identity is already
  verified at that point. An admin can reconcile manually.

## Consequences

Positive:

- A fresh PowerDNS-AuthAdmin install boots into a fully-configured state
  with one YAML committed alongside the rest of the deployment manifest.
- The same YAML can drive dev, staging, and prod environments by
  parameterising secrets and base URLs.
- OIDC group claims become a first-class authorisation surface without
  requiring an admin to click through user-by-user assignments.

Negative:

- Secrets live in the file verbatim. Operators must enforce file mode +
  ownership; for production the file is typically mounted from a secret
  manager (Kubernetes Secret, HashiCorp Vault, etc.).
- The `provisioned_at` sentinel is the only deduplication gate. If the
  operator alters the file post-provision and wants the changes
  re-applied, they must delete the sentinel manually. The applier prints
  a clear message when it skips; the alternative ("always apply") would
  surprise operators using the admin UI as the source of truth.
- Custom roles whose slug shadows a system slug (e.g. someone writes
  `super-admin` in `roles:`) silently override the seeded definition.
  The applier accepts this; a future check could refuse system slugs to
  prevent accidents.

## Notes for operators

- **Mount the file read-only.** Compose example:
  `./provisioning.yaml:/etc/powerdns-authadmin/provisioning.yaml:ro`.
- **Re-provision:** `DELETE FROM settings WHERE key='provisioned_at';`
  then restart.
- **Disable on boot:** `PROVISION_ON_BOOT=false` + a manual
  `npm run provision` in CI/CD.
- **Group mappings only fire for DB-source OIDC providers.** The env
  fallback provider (`OIDC_*` env vars) doesn't support group mappings;
  switch to a DB-source provider via this file if you need them.
