# ADR 0024 - Zone-scoped roles grant zone access

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @Nefise-Akar

## Context

A role assignment carries a scope - `global`, `team:<id>`, `zone:<name>` or `server:<id>` - and
the documentation promised that "Zone Editor scoped to `zone:corp.example.`" lets a user edit that
one zone. It did not. IdP group sync stored the scope faithfully on the session
(`sessions.derived_permissions` held `{scopeType: "zone", scopeId: "corp.example.", permissions:
[zone.read, record.read, record.create, …]}`), but nothing ever honoured it.

The cause was a deliberate earlier decision, recorded in the header of
`lib/rbac/zone-permissions.ts`: zones live in PowerDNS and have no local row, so a CASL rule with a
condition on a zone can't be evaluated against a zone instance. Role-based zone access was therefore
made **all-or-nothing** - only a GLOBAL role counted - and fine-grained access was expressed by
`zone_grants` rows (`(user|team, server, zone, permissions)`). That closed a real hole (a
type-level `ability.can("update", "Record")` is true for any scoped rule and once let a scoped role
act on every zone), but it left zone scopes inert: the zones list, the zone page, record writes and
every other zone surface checked `globalPermissions` + `zone_grants` and nothing else. A user in the
`dns-corp` IdP group saw no zones and got "missing zone.read" on the zone the mapping named. The nav
made it worse: it used type-level CASL checks, so the same user was offered Zones, Servers, Users,
Settings, … and every click was refused.

## Decision

We will count a role assignment scoped to `zone:<name>` - admin-issued `role_assignments` and
IdP-derived session permissions alike - toward the effective permissions on that zone, exactly as a
`zone_grants` row counts.

- `getCurrentUser` builds `zoneScopedPermissions: Map<canonical zone name, Set<permission>>` from the
  same (token-narrowed) source list it builds the ability and `globalPermissions` from.
- `lib/rbac/zone-permissions.ts` is the single decision point. `canActOnZone(auth, {serverId,
zoneName, permission})` returns true for a global permission, OR a `zone_grant` for this exact
  (server, zone), OR a zone-scoped role on this zone name. `listableZoneFilter` / `canListZones`
  decide the zones list and its nav entry; `hasZoneScopedPermission` serves the realtime stream,
  which only knows zone names. Every zone surface - zones list, zone page and tabs, RRset / settings
  / DNSSEC / metadata / TSIG-transfer writes, zone delete and export, clone's source check,
  realtime events, MCP tools, DynDNS - calls these helpers instead of combining the sources itself.
- A zone scope contributes only zone-bound permissions: `zone.*` except `zone.create`, `record.*`,
  `soa.*`, `dnssec.*`, `metadata.*`. Everything else in the role is dropped when the map is built.
- A zone scope is matched by name on **any backend**, after `canonicalZoneName` on both sides.
- The navigation shows an entry only when the linked page's own guard would admit the user
  (`lib/rbac/nav-access.ts`): global permissions for the global-only admin pages, the any-instance
  check for Teams, `canListZones` for Zones.

The CASL ability is unchanged. Team- and server-scoped roles still don't open zones.

## Rationale

The scope was already in the data model, the provisioning schema, the IdP mapping forms and the
docs; operators reasonably configured it. Making it work is less surprising than removing it, and a
directory group per zone is how most organisations want to delegate DNS.

Resolving it by name in one pure helper keeps the property the old decision was protecting: no
decision anywhere uses a type-level CASL check, so a scoped rule can't widen into "any zone". The
helper is the only place the three sources meet, so a surface can't accidentally honour one source
and ignore another.

Matching on any backend follows from the data we have: a zone scope (and the IdP mapping that
produces it) carries a zone name and no server. Pinning it to a server would need a new scope
syntax and a migration of stored mappings for no gain in the common case, where a name identifies
one zone and all its replicas (cluster peers, secondaries).

## Alternatives considered

- **Keep zone scopes inert and fix the docs.** Honest, but leaves a configuration surface that
  silently does nothing, and per-zone delegation from the IdP impossible.
- **Synthesize `zone_grants` rows from zone scopes.** Grants are keyed by server, so we'd have to
  fan one scope out over every backend, and the result would sit in a table the admin UI presents as
  hand-issued state.
- **Evaluate scopes through CASL with synthetic zone instances.** Every call site would have to
  build a `{__type: "Zone", id}` instance correctly; one site passing a bare type string reopens the
  any-zone hole. A plain set lookup is harder to misuse.
- **Introduce a `zone:<server>/<name>` scope.** Precise, but a breaking change to stored IdP
  mappings and provisioning files; deferred until someone needs it.

## Consequences

- A zone-scoped role works on the zones list, the zone page and every zone API, from both the admin
  and the IdP path. Token (PAT/MCP) callers get it narrowed by the token's scopes, as for every other
  source. DynDNS honours admin-issued zone scopes; it never used IdP-derived permissions.
- **Any-backend matching.** `zone:example.com.` covers a zone named `example.com.` on every backend,
  including an unrelated primary serving a same-named zone (e.g. an internal copy next to the public
  one). Operators who need backend-pinned access use a `zone_grant`. Documented in docs/07-RBAC.md.
- The admin role-assignment route still refuses `zone` scope (the Postgres `scope_id` column is a
  UUID), so today zone scopes come from IdP mappings; admin-issued zone-scoped rows are honoured
  wherever they exist (SQLite, restored backups) and the route can be opened later without touching
  authorization.
- Grant-delegation ceilings (`/admin/users/:id/zone-grants`, team grants, team membership) still
  count only global permissions and grants. A zone-scoped role lets you act on a zone, not hand it
  on.
- Not addressed here: team- and server-scoped IdP mappings saved from the admin UI stored slugs while
  the authorizer compared UUIDs, so they granted nothing. Fixed separately (#200): group sync
  resolves the slug at sign-in.

### Threat model

What could go wrong, and what prevents it:

- **Over-granting through the role's other permissions.** Read Only carries `user.read`,
  `server.read`, `settings.read`; scoped to a zone, those must not open the admin pages. The scoped
  map keeps only zone-bound permissions, and it is never merged into `globalPermissions`, which is
  what every global-only gate (users, roles, servers, settings, audit, TSIG, templates, zone
  creation) checks. `zone.create` is excluded at collection time and again at check time.
- **Leaking to other zones.** The lookup is an exact match on the canonical name: no suffix or
  parent/child matching, so `zone:a.example.` doesn't cover `b.a.example.` or `example.`. The zones
  list filter and the realtime filter use the same name set; the zone page and APIs re-check per
  request.
- **A mapping typo.** A misspelt zone name matches nothing (fail-closed). A mapping that names the
  wrong zone grants exactly that zone - the same blast radius as a mistyped grant - and the
  OIDC/SAML/LDAP mapping ceiling (GHSA-wf29-rmhc-rqc9) still stops an operator from mapping a role
  whose permissions exceed their own global set.
- **The same zone name on several backends.** Covered on all of them, by design. Where that's not
  acceptable, use backend-pinned `zone_grants` instead of a zone scope, or give the internal copy a
  distinct name. Every write is still audited with the backend it hit.
- **Stale IdP membership.** Unchanged from today: derived permissions live on the session and are
  recomputed at the next sign-in (and for tokens, by the live recompute / fallback TTL).
- **A future call site bypassing the helper.** Zone decisions are funnelled through
  `canActOnZone`/`listableZoneFilter`; `requireUser({ can })` without an instance remains global-only,
  so a new route that forgets the helper fails closed for scoped users rather than open.

## References

- ADR-0004 (three-layer architecture), ADR-0012 (provisioning + group mapping), ADR-0023 (zone
  authority permissions).
- `lib/rbac/zone-permissions.ts`, `lib/rbac/nav-access.ts`, `lib/auth/get-current-user.ts`.
- docs/07-RBAC.md § Scopes, docs/05-OIDC.md § Group → role mapping.
