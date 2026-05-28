/**
 * app/(app)/zones/[zoneId]/_components/access-section.tsx
 *
 * Zone "Access" tab — a single surface that summarises who can touch
 * this zone and via what mechanism. Three sub-lists in order:
 *
 *   1. Roles that grant zone-scope permissions. Dynamically derived
 *      from each role's `permissions` column — a role surfaces here iff
 *      it carries any permission in the zone vocab (the same regex
 *      ZONE_GRANT_PERMISSIONS uses). System roles end up on the list
 *      naturally because their permission set includes zone perms;
 *      nothing is hardcoded.
 *
 *   2. Teams with an explicit `zone_grants` row on this (server, zone)
 *      pair. Members of the team inherit the listed permissions.
 *
 *   3. Users with an explicit, direct `zone_grants` row on this
 *      (server, zone). The role / team paths above show the indirect
 *      access; this section is the "operator named this specific
 *      person on this specific zone" view.
 *
 * Empty sub-lists collapse to a short note instead of an empty
 * shell — visually obvious that "nothing here" is the real answer.
 */

import { listGrantsForZone } from "@/lib/db/repositories/zone-grants";
import { listRoles } from "@/lib/db/repositories/roles";
import { ZONE_GRANT_PERMISSIONS } from "@/lib/rbac/zone-grant-permissions";
import { LocalTime } from "@/components/ui/local-time";

const ZONE_PERM_SET = new Set<string>(ZONE_GRANT_PERMISSIONS);

interface Props {
  serverId: string;
  zoneName: string;
}

export async function AccessSection({ serverId, zoneName }: Props) {
  const [allRoles, grants] = await Promise.all([
    listRoles(),
    listGrantsForZone({ serverId, zoneName }),
  ]);

  // Roles that grant any zone-scope permission. Filter the permissions
  // list per role to the zone-relevant subset; a role with both
  // `zone.read` and `user.update` shows only the former here.
  const rolesWithZoneAccess = allRoles
    .map((role) => ({
      ...role,
      zonePermissions: role.permissions.filter((p) => ZONE_PERM_SET.has(p)),
    }))
    .filter((role) => role.zonePermissions.length > 0)
    // Stable order: system roles first, then custom; alphabetic within each.
    .sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const teamGrants = grants.filter((g) => g.team !== null);
  const userGrants = grants.filter((g) => g.user !== null);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Roles with zone permissions
        </h2>
        <p className="mb-3 text-xs text-[color:var(--color-fg-muted)]">
          Every role whose permission set includes zone-scope actions. Operators with these roles
          assigned (globally, or at a matching team / server scope) can act on this zone.
        </p>
        {rolesWithZoneAccess.length === 0 ? (
          <p className="text-xs text-[color:var(--color-fg-muted)] italic">
            No role grants any zone-scope permission.
          </p>
        ) : (
          <ul className="space-y-2">
            {rolesWithZoneAccess.map((role) => (
              <li
                key={role.id}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{role.name}</span>
                  <code className="font-mono text-xs text-[color:var(--color-fg-muted)]">
                    {role.slug}
                  </code>
                  {role.isSystem ? (
                    <span className="rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase">
                      System
                    </span>
                  ) : null}
                </div>
                {role.description ? (
                  <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                    {role.description}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1">
                  {role.zonePermissions.map((p) => (
                    <code
                      key={p}
                      className="rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 font-mono text-[0.625rem]"
                    >
                      {p}
                    </code>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Teams with grants on this zone
        </h2>
        <p className="mb-3 text-xs text-[color:var(--color-fg-muted)]">
          Members of these teams inherit the listed permissions on this zone.
        </p>
        {teamGrants.length === 0 ? (
          <p className="text-xs text-[color:var(--color-fg-muted)] italic">
            No teams have a direct grant on this zone.
          </p>
        ) : (
          <ul className="space-y-2">
            {teamGrants.map((g) =>
              g.team ? (
                <PrincipalGrantRow
                  key={g.id}
                  title={g.team.name}
                  subtitle={`team · ${g.team.slug}`}
                  permissions={g.permissions}
                  createdAt={g.createdAt}
                />
              ) : null,
            )}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Users with direct grants on this zone
        </h2>
        <p className="mb-3 text-xs text-[color:var(--color-fg-muted)]">
          Users named individually on this zone. Inherited access via roles or teams is shown above.
        </p>
        {userGrants.length === 0 ? (
          <p className="text-xs text-[color:var(--color-fg-muted)] italic">
            No users have a direct grant on this zone.
          </p>
        ) : (
          <ul className="space-y-2">
            {userGrants.map((g) =>
              g.user ? (
                <PrincipalGrantRow
                  key={g.id}
                  title={g.user.name ?? g.user.email}
                  subtitle={g.user.name ? g.user.email : null}
                  permissions={g.permissions}
                  createdAt={g.createdAt}
                />
              ) : null,
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function PrincipalGrantRow({
  title,
  subtitle,
  permissions,
  createdAt,
}: {
  title: string;
  subtitle: string | null;
  permissions: readonly string[];
  createdAt: Date;
}) {
  return (
    <li className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {subtitle ? (
            <div className="text-xs text-[color:var(--color-fg-muted)]">{subtitle}</div>
          ) : null}
        </div>
        <div className="shrink-0 text-xs text-[color:var(--color-fg-muted)]">
          granted <LocalTime ts={createdAt} />
        </div>
      </div>
      {permissions.length === 0 ? (
        <p className="mt-2 text-xs text-[color:var(--color-fg-muted)] italic">
          Grant row exists but no permissions are attached.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          {permissions.map((p) => (
            <code
              key={p}
              className="rounded bg-[color:var(--color-bg-muted)] px-1.5 py-0.5 font-mono text-[0.625rem]"
            >
              {p}
            </code>
          ))}
        </div>
      )}
    </li>
  );
}
