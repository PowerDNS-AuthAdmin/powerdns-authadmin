/**
 * lib/auth/email-domain-allowlist.ts
 *
 * Pure email-domain matcher used by the OIDC provisioning gate (S-7).
 * Lives in its own module so unit tests can exercise it without dragging
 * in the OIDC provider's `openid-client` + DB repository imports.
 *
 * Semantics:
 *   - An empty `allowedDomains` array means "no restriction" - always
 *     returns `{ ok: true }`. Preserves Phase-1 OIDC behavior when the
 *     operator hasn't opted into gating.
 *   - Comparison is case-insensitive on the part after the rightmost `@`.
 *   - Inputs without a `@` (or with an empty domain part) get the literal
 *     sentinel `(no-@-in-email)` as `domain` and are rejected when the
 *     allow-list is non-empty.
 *   - Exact-domain match only - `evil-example.com` is NOT accepted when
 *     `example.com` is in the list. Subdomain matching needs an explicit
 *     entry per subdomain.
 *
 * Callers should record the returned `domain` (not the full email) when
 * auditing rejections - see S-7's PII-minimization requirement.
 */

export type DomainCheckResult = { ok: true; domain: string } | { ok: false; domain: string };

export function emailDomainAllowed(
  email: string,
  allowedDomains: readonly string[],
): DomainCheckResult {
  const at = email.lastIndexOf("@");
  const domain =
    at >= 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : "(no-@-in-email)";
  if (allowedDomains.length === 0) return { ok: true, domain };
  return allowedDomains.includes(domain) ? { ok: true, domain } : { ok: false, domain };
}

/**
 * Resolve the effective allow-list for a given OIDC provider (S-7
 * per-provider override). Rules:
 *
 *   - `providerOverride === null` → inherit the env default
 *     (operator hasn't set an override; env value applies - could
 *     itself be empty meaning "no restriction").
 *   - `providerOverride` is an empty array `[]` → explicit "no
 *     restriction at this provider, regardless of env" - useful for
 *     a public-signup provider on an otherwise-locked-down server.
 *   - `providerOverride` is non-empty → REPLACES env (does not
 *     append). Operators wanting to extend should re-list env
 *     domains in the override. Replace-semantics keeps the data
 *     model simple and the audit trail unambiguous.
 *
 * Caller still feeds the result to `emailDomainAllowed`. Lower-
 * casing happens inside `emailDomainAllowed`; this resolver just
 * picks which list to use.
 */
export function resolveAllowedDomains(
  providerOverride: readonly string[] | null,
  envDefault: readonly string[],
): readonly string[] {
  if (providerOverride === null) return envDefault;
  return providerOverride;
}
