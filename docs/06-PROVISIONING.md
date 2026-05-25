# First-boot provisioning

Provisioning brings up a **fully-configured install from a single YAML file** —
settings, custom roles, teams, zone templates, PowerDNS clusters and servers,
demo zones, and OIDC providers — with no clicking. It's infrastructure-as-code
for the app's own configuration, ideal for reproducible deployments.

The canonical, every-field reference is
[`provisioning.example.yaml`](../provisioning.example.yaml). This page explains
_how it runs_ and _how to think about it_; reach for the example file for exact
keys.

## How it runs

1. On boot, if `PROVISIONING_FILE` points at a YAML file **and** the
   `settings.provisioned_at` row is absent, the app applies the file.
2. Blocks are processed **in order**: `settings → roles → teams → zone_templates
→ clusters → pdns_servers → oidc → demo_zones`. References resolve by slug, so
   an `oidc` group mapping can point at a role defined earlier in the same file.
3. On success it writes `settings.provisioned_at = <timestamp>`. **Subsequent
   boots skip the file** — from then on the admin UI is the source of truth.
4. **Parse errors abort the boot.** A malformed file means the app refuses to
   start rather than half-applying — fail loud, fix the YAML, retry. Unknown keys
   at any level are rejected, so typos fail fast instead of silently no-op'ing.

```sh
# in your compose/k8s env
PROVISIONING_FILE=/etc/powerdns-authadmin/provisioning.yaml
PROVISION_ON_BOOT=true   # default; set false to skip
```

```yaml
# mount it read-only where PROVISIONING_FILE points
volumes:
  - ./provisioning.yaml:/etc/powerdns-authadmin/provisioning.yaml:ro
```

## It runs once — how to re-apply

The `provisioned_at` sentinel makes provisioning a one-shot. To force a re-apply,
delete the sentinel row and restart:

```sh
# Postgres
psql "$DATABASE_URL" -c "DELETE FROM settings WHERE key='provisioned_at';"

# SQLite
sqlite3 /data/powerdns_authadmin.db "DELETE FROM settings WHERE key='provisioned_at';"
```

On re-apply, providers/servers/roles are **created or updated by slug** — the
applier never deletes. Anything you added in the UI that isn't in the file stays.

## Secrets in the file

PowerDNS `api_key`s and OIDC `client_secret`s live in this file in **plaintext**
and are encrypted with `APP_ENCRYPTION_KEY` before they hit the database. Treat
the file as sensitive:

- `chmod 600`, owned by the app's runtime user, mounted **read-only**.
- Prefer mounting from a secret store (Docker secret, K8s `Secret`, Vault).

## The blocks at a glance

Every block is optional — drop what you don't need.

| Block            | What it creates                   | Notes                                                                                           |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `version`        | (guard)                           | If set, the applier refuses to run unless the app version matches the prefix.                   |
| `settings`       | Global settings rows              | Site name, support contact, login intro, lockout policy. Mirrors the admin Settings page.       |
| `roles`          | Custom roles                      | The 5 system roles are seeded separately and can't be redefined here. See [RBAC](./07-RBAC.md). |
| `teams`          | Teams                             | Ownership boundaries for scoped roles.                                                          |
| `zone_templates` | New-zone scaffolding              | SOA timers, kind, NS, prelude records, zone settings, metadata.                                 |
| `clusters`       | Multi-primary peer groups         | Peer-selection strategy. See [Backends](./04-BACKENDS.md).                                      |
| `pdns_servers`   | The PowerDNS backends             | Primaries, secondaries, cluster peers. Encrypted API keys.                                      |
| `demo_zones`     | Generated demo zones              | For showcasing a fresh stack; omit in production.                                               |
| `oidc`           | OIDC providers (+ group mappings) | Same `oidc_providers` table the UI writes. See [OIDC](./05-OIDC.md).                            |

### Cross-block rules worth knowing

- `pdns_servers`: `role: secondary` requires `primary_slug` (resolving in-file or
  to an existing DB primary); a primary must **not** set `primary_slug`; a
  secondary must **not** set `cluster_slug`; exactly one row should be `is_default`.
- `clusters`: only primaries can be cluster peers — putting `cluster_slug` on a
  secondary is a parse error.
- `oidc`: this is the **same mechanism as the Admin UI** (rows in
  `oidc_providers`). It coexists with the read-only env (`OIDC_*`) provider; a DB
  provider with the same slug shadows the env one. Group mappings reference
  roles/teams/servers by slug. See the
  [OIDC configuration paths](./05-OIDC.md#the-three-ways-to-configure-oidc--and-how-they-relate).

## Minimal example

A standalone primary, one custom role, and one SSO provider:

```yaml
settings:
  site_name: "Acme DNS"
  support_contact: "ops@acme.example"

roles:
  - slug: zone-noc
    name: NOC Zone Operator
    requires_mfa: true
    permissions: [zone.read, record.create, record.update, record.delete, audit.read]

pdns_servers:
  - slug: primary-1
    name: "Primary (prod)"
    base_url: "https://pdns.acme.example/api/v1"
    api_key: "REPLACE_ME_api_key"
    role: primary
    is_default: true

oidc:
  - slug: company-sso
    name: "Company SSO"
    issuer_url: "https://auth.acme.example/realms/acme"
    client_id: "powerdns-authadmin"
    client_secret: "REPLACE_ME_client_secret"
    scopes: "openid profile email groups"
    enabled: true
    group_mappings:
      - { group: pdns-admins, role: super-admin, scope: global }
      - { group: pdns-noc, role: zone-noc, scope: global }
```

For every available field with inline documentation, copy
[`provisioning.example.yaml`](../provisioning.example.yaml).

## Topology examples

The repo ships ready-to-run Postgres-backed stacks demonstrating each topology,
each with a matching provisioning file:

- [`docker-compose-primary-secondaries.yml`](../docker-compose-primary-secondaries.yml) + [`provisioning.primary-secondary.example.yaml`](../provisioning.primary-secondary.example.yaml)
- [`docker-compose-multi-primary.yml`](../docker-compose-multi-primary.yml) + [`provisioning.multi-primary.example.yaml`](../provisioning.multi-primary.example.yaml)
- [`docker-compose-combined.yml`](../docker-compose-combined.yml) + [`provisioning.combined.example.yaml`](../provisioning.combined.example.yaml)

---

[← Docs index](./README.md)
