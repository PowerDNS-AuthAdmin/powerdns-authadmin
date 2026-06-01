/**
 * lib/rbac/target-ceiling.ts
 *
 * The TARGET-privilege ceiling: a pure comparison guarding account-takeover
 * operations against more-privileged targets.
 *
 * `user.reset-password` and `user.update` (MFA removal) holders can act on any
 * user. Without this ceiling a mid-tier operator could reset a Super Admin's
 * password (then read it via the single-use `/reveal` route) or strip their
 * TOTP - a full takeover of an account holding permissions the actor lacks. So
 * before such an operation we require that the target holds no GLOBAL permission
 * the actor doesn't also hold globally; otherwise the actor would be acquiring
 * control over privileges above their own authority.
 *
 * Global scope is the basis for the same reason it is in `permissionsExceeding-
 * Grant`: a global grant is the genuine "all instances" capability, and these
 * gates (`user.reset-password`, `user.update`) are global-only.
 *
 * Self-target is inherently safe: an actor's own permission set is a subset of
 * itself, so this returns [] when actor and target are the same user.
 *
 * Pure by design - no DB import, so it lives in the rbac layer and is unit-
 * testable. Permission values are typed as bare strings here (the structural
 * shape of the DB column) to keep this free of a lib/db dependency; callers cast
 * their loaded sets at the boundary.
 */

/**
 * The global permissions the TARGET holds that the ACTOR does not. An empty
 * result means the actor is at least as privileged as the target globally, so
 * the takeover-class operation is within the ceiling.
 */
export function permissionsTargetHoldsBeyondActor(
  actorGlobalPerms: ReadonlySet<string>,
  targetGlobalPerms: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const p of targetGlobalPerms) {
    if (!actorGlobalPerms.has(p)) out.push(p);
  }
  return out;
}
