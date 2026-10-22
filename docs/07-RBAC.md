# Roles & permissions (RBAC)

Access is granted by assigning **roles** to users, optionally **scoped** to a
team, zone, or server. A role is a named bundle of permissions; the effective
permission set is the union of a user's assignments that apply in context.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/roles.png" />
  <img src="../screenshots/light/roles.png" alt="Roles - seeded system roles + operator-defined custom roles" width="720" />
</picture>

## The five system roles

Seeded on first boot and protected from deletion. Each builds on the previous -
the description shown here is the one seeded into the `roles.description`
column, surfaced verbatim on the Roles list and detail pages.

| Role            | Seeded description                                                                                     | Permissions, in addition to the role above…                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Read Only**   | View access to assigned zones. No changes. Useful for auditors and observers.                          | View zones, records, DNSSEC, metadata, teams, users, roles, servers, settings; use templates; manage own API tokens (read). |
| **Zone Editor** | Edit records on assigned zones. Cannot create or delete zones, change the SOA, or repoint the apex NS. | Create/update/delete **records**; create/delete own API tokens.                                                             |
| **Operator**    | Day-to-day zone and record administration within a team. No DNSSEC or member management.               | Update the **SOA** + **apex NS**; create/update/delete/import/export **zones**; write metadata; manage templates.           |
| **Team Owner**  | Full control of a team's zones and members. Cannot manage other teams or app-wide settings.            | Configure DNSSEC; manage TSIG + autoprimaries; update team + manage members.                                                |
| **Super Admin** | Full access to everything: users, roles, servers, settings, audit.                                     | Everything: users, roles, teams, servers, settings, audit, OIDC, all API tokens.                                            |

The seed asserts Super Admin contains every permission, so a new permission added
to the codebase is always held by Super Admin. The seeded descriptions are owned
by `lib/rbac/default-roles.ts`; edits there apply on next boot via `upsertRole`.

Custom roles carry an optional free-text description too - set it on the create
or edit form. It's shown verbatim on the Roles list and detail pages and surfaces
naturally as "what does this role do?" context for newer operators.

## Permission vocabulary

Custom roles are built from these. Names are stable strings (`resource.action`):

| Group            | Permissions                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| Zones            | `zone.read` `zone.create` `zone.update` `zone.delete` `zone.export` `zone.import` `zone.settings.read` |
| Records          | `record.read` `record.create` `record.update` `record.delete` `record.update.apex-ns`                  |
| SOA              | `soa.read` (see the SOA tab) · `soa.update` (edit it)                                                  |
| DNSSEC           | `dnssec.read` `dnssec.configure`                                                                       |
| Metadata         | `metadata.read` `metadata.write`                                                                       |
| TSIG             | `tsig.read` (list) · `tsig.manage` (create/regenerate/reveal)                                          |
| Autoprimary      | `autoprimary.manage`                                                                                   |
| Templates        | `template.use` `template.manage`                                                                       |
| Users            | `user.read` `user.create` `user.update` `user.delete` `user.disable` `user.reset-password`             |
| Teams            | `team.read` `team.create` `team.update` `team.delete` `team.manage-members`                            |
| Roles            | `role.read` `role.create` `role.update` `role.delete` `role.assign`                                    |
| Servers          | `server.read` `server.create` `server.update` `server.delete`                                          |
| API tokens       | `token.read.own` `token.create.own` `token.delete.own` `token.read.all` `token.delete.all`             |
| Audit & settings | `audit.read` `settings.read` `settings.write`                                                          |
| Auth providers   | `auth.read` `auth.manage` (OIDC, SAML, LDAP)                                                           |
| System           | `system.backup`                                                                                        |

## Splitting record editing from a zone's authority

Three surfaces decide whether a zone works at all, and each answers to its own
permission rather than riding along with `record.update`. This is what lets you
hand someone their zone's records without handing them the zone.

| Surface                                                             | Read                 | Write                                       |
| ------------------------------------------------------------------- | -------------------- | ------------------------------------------- |
| **SOA tab** - primary NS, responsible mailbox, refresh/retry/expire | `soa.read`           | `soa.update`                                |
| **Apex NS records** - the zone's delegation                         | `record.read`        | `record.*` **plus** `record.update.apex-ns` |
| **Zone settings tab** - kind, masters, SOA-EDIT(-API), API-RECTIFY  | `zone.settings.read` | `zone.update`                               |

Notes worth knowing:

- **Tabs disappear, they don't grey out.** Without `soa.read` there is no SOA
  tab; without `zone.settings.read` there is no Zone settings tab, and a direct
  `?tab=soa` / `?tab=settings` link falls back to Records. (A user holding
  `zone.delete` still gets the settings tab, because the Danger Zone lives
  there - the settings panel itself stays hidden.)
- **`soa.update` replaces the record permission, it doesn't add to it.** The SOA
  is its own resource: `soa.update` alone is enough to edit it, and no amount of
  `record.*` substitutes for it. `record.update.apex-ns` works the other way -
  it is an _extra_ requirement layered on top of the matching `record.create` /
  `record.update` / `record.delete`.
- **NS below the apex is an ordinary record.** A child delegation
  (`sub.example.com. NS`) is content this zone serves, so `record.*` covers it.
  Only the apex NS is protected.
- **The gate is server-side.** Every write lands on the same RRset route
  whichever panel sent it, and the route classifies each change by its
  normalized name - a hand-rolled `PATCH` gets the same answer the UI does.
- **These work as per-zone grants and in zone-scoped roles too**, so you can
  allow `soa.update` on one customer's zone without granting it fleet-wide.

[ADR-0023](./adr/0023-zone-authority-permissions.md) records why the SOA is
modelled as its own resource while the apex NS stays a record with an extra
cost, and what was rejected on the way there.

A self-service role for a hosting customer therefore looks like:

```yaml
permissions: [zone.read, record.read, record.create, record.update, record.delete, dnssec.read]
```

Records: yes. SOA, apex NS, zone settings: not shown, not writable.

## Scopes

A role assignment can apply everywhere or be narrowed:

| Scope              | Applies to                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `global`           | The whole app.                                                                                                                   |
| `team:<slug>`      | The named team itself (view / update / manage members). Does **not** open any zone - see below.                                  |
| `zone:<zone-name>` | Every zone with that name, on any backend (canonical FQDN with trailing dot, e.g. `corp.example.`). Zone-bound permissions only. |
| `server:<slug>`    | The backend object itself. Does **not** open the zones on it - see below.                                                        |

Example: map an IdP group to **Zone Editor** scoped to `zone:corp.example.` and its
members can open `corp.example.` from the Zones list and edit its records - and
nothing else. The Zones list shows them only that zone; every other zone, and the
admin pages, refuse them.

### What a zone scope grants

Effective access to a zone is the union of three sources, checked by one helper
(`canActOnZone` in `lib/rbac/zone-permissions.ts`) on the zones list, the zone page
and its tabs, every record / SOA / settings / DNSSEC / metadata write, zone
export, the realtime stream, MCP tools and DynDNS:

1. a role assigned at `global` scope;
2. a [per-zone grant](#per-zone-grants) for that exact (server, zone);
3. a role scoped to `zone:<that zone's name>`.

A zone-scoped role contributes only its **zone-bound** permissions: `zone.*`
(except `zone.create`), `record.*`, `soa.*`, `dnssec.*` and `metadata.*`. Anything
else the role carries - `user.read`, `server.read`, `settings.read`, `tsig.*`,
`token.*` - is ignored at zone scope, so a Read Only role scoped to one zone does
not let the user read users, servers or settings. `zone.create` always needs a
global assignment: a zone that doesn't exist yet can't be inside a zone scope.
The role's own limits still apply - a zone-scoped Zone Editor gets no SOA tab, no
apex NS writes and no Zone settings tab, exactly like a global one.

The Zones list shows a zone-scoped zone when the role carries `zone.read`; the SOA,
Zone settings, DNSSEC and Metadata tabs follow `soa.read`, `zone.settings.read`,
`dnssec.read` and `metadata.read` as usual.

**A zone scope names a zone, not a backend.** `zone:corp.example.` matches a zone
called `corp.example.` on every backend the app manages - all peers of a cluster,
and also an unrelated primary that happens to serve a zone with the same name (for
example an internal and a public copy). The name is compared case-insensitively
and with or without the trailing dot. If you need access pinned to one backend,
use a per-zone grant instead; it carries a server.
[ADR-0024](./adr/0024-zone-scoped-roles-grant-zone-access.md) records the trade-off.

### Assigning a zone scope

**Admin → Users → _user_ → Role assignments** takes a **Zone** scope: pick the
role, choose _Zone_ and type the zone name. It is stored canonically (lowercase,
trailing dot), so `Corp.Example` and `corp.example.` are the same assignment. The
assignment is accepted even when no backend serves the zone yet - a warning says
so, and it grants nothing until the zone exists. IdP group mappings produce the
same scope from a directory group.

### Per-zone grants

A `zone_grants` row (Admin → Users / Teams → _Zone grants_) gives a user or a team a
list of permissions on exactly one (server, zone), without a role. Grants are the
way to pin access to one backend, and the way to give a whole team zone access.

### Known limitations

- **Team- and server-scoped roles don't open zones.** Zones live in PowerDNS and
  carry neither a team nor a server binding the authorizer can match, so a
  `team:` or `server:` assignment never grants zone or record access. Use team
  zone grants for "this team edits these zones".

List pages follow the same rule. A **Team Owner** scoped to `team:<slug>` can open
**Admin → Teams**, but the list only shows the teams their assignments cover.
Creating a team still takes a global `team.create`, because a new team has no
scope to match yet. The navigation menu shows an entry only when its page would
admit you: a user whose only access is zone-scoped sees **Zones** and nothing
admin-wide.

## Assigning roles

- **Admin UI** - assign roles to a user (with a scope) under **Admin → Users**;
  manage role definitions under **Admin → Roles**.
- **OIDC / SAML / LDAP group mapping** - map an IdP group to a role + scope so
  membership is driven by your directory. All three provider types run the same
  group sync, and the result is recomputed on every sign-in (granted when in the
  group, gone when not). See [OIDC](./05-OIDC.md#group--role-mapping),
  [SAML](./13-SAML.md#group--role-mapping), [LDAP](./12-LDAP.md#group--role-mappings).

Admin-issued assignments and IdP-derived permissions are tracked separately - the
group sync never touches an assignment an admin made by hand.

## Custom roles

Add org-specific roles in the UI (**Admin → Roles**) or in the `roles:`
[provisioning](./06-PROVISIONING.md) block. A custom role is just a slug, a name, and
a list of permissions from the vocabulary above. They can be used anywhere a
system role can, including IdP group mappings.

```yaml
roles:
  - slug: zone-noc
    name: NOC Zone Operator
    requires_mfa: true
    permissions: [zone.read, record.create, record.update, record.delete, audit.read]
```

## MFA-required roles

A role can be marked **`requires_mfa`**. A user holding such a role must enrol a
second factor - TOTP **or** a passkey / security key
([WebAuthn](./11-PASSKEYS.md)) - before they can act; they're redirected to enrol
until they do. SSO-only users (no local password) are exempt: their IdP is the
second-factor authority, so enforce MFA there. See
[OIDC → MFA and SSO users](./05-OIDC.md#mfa-and-sso-users).

---

[← Docs index](./README.md)
