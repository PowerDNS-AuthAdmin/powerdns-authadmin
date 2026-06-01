# LDAP authentication

PowerDNS-AuthAdmin can authenticate users by direct bind against **Active
Directory** or **OpenLDAP**. There's no federation broker in the path - the app
binds with a service account, looks the user up, and re-binds as that user with
the password they typed. Groups feed the same `applyGroupSync` machinery as the
OIDC path, so the operator's mental model is consistent across both protocols.

The design is locked in [ADR-0020](./adr/0020-ldap-architecture.md). This
document is the operator guide.

## How sign-in works

```
1. Browser POSTs username + password to /api/auth/ldap/<slug>/login
2. App opens an LDAP connection to `server_url`
3. If start_tls=true on the provider row → upgrade with StartTLS (RFC 4511 §4.14)
4. App binds as `bind_dn` / `bind_password`
5. App searches `user_search_base` with `user_search_filter`
       ({{username}} is replaced by the LDAP-escaped login - RFC 4515)
6. App re-binds as the user's DN + their typed password
7. App reads email + display name + group memberships
       (group_attr first - typically `memberOf`; second search if empty
        AND group_search_base + group_search_filter are configured)
8. App provisions the local users row (if absent) and applies group → role
   mappings via the shared applyGroupSync differ.
```

A failed step 6 (user-password bind) is "invalid credentials"; failure at any
earlier step is "transport" or "tls" - the operator sees a different log line
than the user.

## Configuration

Configure LDAP under **Admin → Authentication** ([screenshot](../screenshots/light/authentication.png)).
The form has these sections.

### Connection

- **Server URL** - `ldaps://host:636` (preferred) or `ldap://host:389`.
- **StartTLS** - when on, the app upgrades a plain `ldap://` connection after
  connecting. Has no effect on `ldaps://` URLs; the validator refuses the
  redundant pair.

Strict TLS by default. Plain `ldap://` is **refused** unless either:

- the row sets `start_tls: true`, OR
- the env knob `LDAP_ALLOW_INSECURE_PORT_389=true` is set (env-level opt-in for
  a trusted LAN - see `.env.example`).

Self-signed / mismatched certs are **refused** unless the loud opt-in
`LDAP_TLS_INSECURE_SKIP_VERIFY=true` is set. Prefer pinning the internal CA on
the provider row (PEM textarea) over disabling verification.

### Bind

- **Service-account DN** - the DN the app binds with for the user lookup.
  Operators typically create a dedicated read-only account.
- **Bind password** - encrypted at rest (AES-256-GCM envelope). Shown only at
  creation time; on the edit page it's a "rotate" field - leave blank to keep.

### User search

- **User search base** - DN under which user records live. The search is `sub`,
  so nested OUs are fine.
- **User search filter** - the RFC 4515 filter applied at the search step. The
  literal string `{{username}}` is replaced with the LDAP-escaped form of what
  the user typed. Operators commonly need to match against several attributes:

  ```text
  # Active Directory - matches sAMAccountName, userPrincipalName, or mail:
  (|(sAMAccountName={{username}})(userPrincipalName={{username}})(mail={{username}}))

  # OpenLDAP - uid or mail:
  (|(uid={{username}})(mail={{username}}))
  ```

  The validator requires `{{username}}` to be present and the parens to balance.

### Group resolution

Two paths. The app reads `group_attr` from the user record **first** - the
common case (AD's `memberOf` is fully resolved by the DC at query time). If the
attribute is absent or empty AND the second search is configured, the app does
a second search:

- **Group search base** - DN under which group records live.
- **Group search filter** - RFC 4515 filter with a `{{userDn}}` placeholder
  (replaced with the LDAP-escaped DN of the just-authenticated user).

For AD, leave the second-search pair blank. For OpenLDAP without the `memberof`
overlay, use something like:

```text
(&(objectClass=groupOfNames)(member={{userDn}}))
```

### Claims

- **Email attribute** - defaults to `mail`. The app keys user accounts by the
  email returned here, so it must be a stable identifier for the directory.
- **Display name attribute** - defaults to `displayName`.

### Email-domain allow-list (optional)

When set, the app refuses to **auto-provision** a new local account for an
email outside the list. Existing accounts keep signing in regardless. The
field is per-provider and **has no env-level default** - leave it off for
"any directory user with a valid email gets an account."

### Group → role mappings

Same shape as the OIDC mappings. Each row maps a group string to a role at a
specified scope (global / team / zone / server). On every sign-in, matching
roles are materialised; on the next sign-in, ones that no longer match are
revoked. Admin-issued role assignments are never touched.

Group strings are **case-sensitive**. For AD, use the **full DN** of the group
(that's what `memberOf` returns). For OpenLDAP via the second search, the
strings are the DNs returned from the group search - also DN-shaped.

## Worked example - Active Directory

Tested on Windows Server 2022 + the default `Domain Users` OU layout.

1. **LDAPS or StartTLS.** AD installs an "Active Directory Certificate
   Services" CA the first time you promote a domain controller. The DC's
   service cert is on port 636 (LDAPS) by default. Issue a cert from your
   internal CA (no public WebPKI involvement) and pin the CA's PEM on the
   provider row - that's the most operator-friendly path. **Note:** make
   sure [LDAP signing](https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/enable-ldap-signing-in-windows-server)
   (KB4520412) doesn't block unsigned connections from your subnet; LDAPS or
   StartTLS satisfies the channel-binding requirement.
2. **Service account.** Create a regular user (no admin rights), reset their
   password, and store it in the bind-password field. They need read-only
   access to your user OUs - no domain-admin equivalent.
3. **Settings:**

   ```yaml
   server_url: ldaps://ad.corp.example.com:636
   start_tls: false
   bind_dn: CN=svc-authadmin,OU=ServiceAccounts,DC=corp,DC=example,DC=com
   user_search_base: OU=Employees,DC=corp,DC=example,DC=com
   user_search_filter: "(|(sAMAccountName={{username}})(userPrincipalName={{username}})(mail={{username}}))"
   group_attr: memberOf
   claim_email: mail
   claim_name: displayName
   ```

4. **Mapping AD groups.** Right-click the group in AD Users & Computers →
   Properties → click `Object` tab → copy the full DN (it's not on the General
   tab, sadly). Paste that as the `group` value:

   ```yaml
   group_mappings:
     - group: CN=PDNS Admins,OU=Groups,DC=corp,DC=example,DC=com
       role: super-admin
       scope: global
   ```

## Worked example - OpenLDAP 2.6

Tested on Debian 12's `slapd` package.

1. **TLS.** OpenLDAP 2.6 reads its TLS config from `cn=config` via the LDAP
   protocol itself. Set the cipher suite and pin a cert with `ldapmodify`:

   ```ldif
   dn: cn=config
   changetype: modify
   replace: olcTLSCertificateFile
   olcTLSCertificateFile: /etc/ldap/sasl2/openldap.crt
   -
   replace: olcTLSCertificateKeyFile
   olcTLSCertificateKeyFile: /etc/ldap/sasl2/openldap.key
   -
   replace: olcTLSCipherSuite
   olcTLSCipherSuite: HIGH:!aNULL:!eNULL:!MD5:!RC4:!SRP:!PSK:!DSS
   ```

2. **memberof overlay (optional but recommended).** With this overlay enabled,
   user records carry a resolved `memberOf` attribute and you don't need the
   second search:

   ```ldif
   dn: cn=module,cn=config
   objectClass: olcModuleList
   cn: module
   olcModulePath: /usr/lib/ldap
   olcModuleLoad: memberof.la

   dn: olcOverlay=memberof,olcDatabase={1}mdb,cn=config
   objectClass: olcOverlayConfig
   objectClass: olcMemberOf
   olcOverlay: memberof
   olcMemberOfRefint: TRUE
   ```

   Without the overlay, leave `group_attr` at its default and configure the
   second search:

   ```yaml
   group_search_base: ou=Groups,dc=example,dc=com
   group_search_filter: "(&(objectClass=groupOfNames)(member={{userDn}}))"
   ```

3. **Settings (StartTLS variant):**

   ```yaml
   server_url: ldap://openldap.dev.example.com:389
   start_tls: true
   bind_dn: cn=svc-authadmin,ou=ServiceAccounts,dc=example,dc=com
   user_search_base: ou=Users,dc=example,dc=com
   user_search_filter: "(|(uid={{username}})(mail={{username}}))"
   claim_email: mail
   claim_name: cn
   ```

## Provisioning (YAML)

The `ldap:` block under `provisioning.yaml` has the same shape as `oidc:` -
slugs reserve in the cross-type `auth_provider_slugs` table, bind passwords are
encrypted before write, group mappings are validated against your `roles` /
`teams` / `pdns_servers` sections. See the worked AD + OpenLDAP examples in
[`provisioning.example.yaml`](../provisioning.example.yaml).

A bare-slug `auth_default_provider` resolves to LDAP transparently - the
applier consults `auth_provider_slugs` and persists the canonical
`ldap:<slug>` form.

## Setting LDAP as the default sign-in method

On **Admin → Authentication**, the "Default sign-in method" dropdown lists
every enabled provider. Pick an LDAP entry and `/login` will skip the OIDC
buttons and local form on a fresh visit - it bounces through
`/login?ldap=<slug>` so only the chosen provider's form is shown.

Operators with a wedged IdP can always reach the full page with
`/login?force-local=1`. The escape hatch isn't gated by RBAC; it's a literal
URL switch any human can type into their address bar to recover from a
misconfigured default.

## What you don't get

- **Password change against the directory.** AuthAdmin never sends a
  modify-password request to LDAP; the directory remains the source of truth.
- **SASL / Kerberos binds.** Simple binds only. Most operators using
  AuthAdmin from a non-Windows host won't have the Kerberos ticket
  machinery wired up anyway; if you need it, open an issue.
- **Group write-back.** Group memberships are read-only - AuthAdmin doesn't
  write group changes back to the directory.

## Troubleshooting

| Symptom                                                | Likely cause                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `ldap.service-bind.invalid-credentials` in the logs    | The **service-account** password is wrong. The user sees a generic transport error.                     |
| `ldap.user-bind.failed` after the user search succeeds | The user's password is wrong. UX path; the audit log records `reason: invalid-credentials`.             |
| `ldap.user-search.multiple-matches`                    | The filter is too broad and matches more than one record. Tighten it (e.g. add `(objectClass=person)`). |
| `ldap.starttls.failed`                                 | The server doesn't speak StartTLS on the configured port. Use `ldaps://636` instead.                    |
| `ldap.claim.email-missing`                             | The user record has no `mail` attribute (or whatever `claim_email` is set to). Pick a different attr.   |
| Sign-in works but no role assignments materialised     | The `group_attr` is empty and the second search isn't configured - set `group_search_base/filter`.      |
| AD rejects every bind with `LDAP_UNWILLING_TO_PERFORM` | LDAP signing / channel-binding is required (KB4520412). Switch to LDAPS.                                |
| `ldap.authenticate.insecure-transport` warning in logs | You're running plain `ldap://` without StartTLS. Either pin LDAPS or set `start_tls: true`.             |
