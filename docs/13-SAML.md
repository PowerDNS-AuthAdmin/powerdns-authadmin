# SAML 2.0 single sign-on

PowerDNS-AuthAdmin can authenticate users against any SAML 2.0 identity
provider - AD FS, Authentik SAML, Keycloak SAML, Okta SAML, Azure AD SAML,
PingFederate, Shibboleth. Signed assertions are required by default; encrypted
assertions are optional. Group → role mapping mirrors the OIDC equivalent.

Architecture is captured in ADR-0021. This page is the operator setup guide.

## Quick reference

| Endpoint                             | Purpose                                  |
| ------------------------------------ | ---------------------------------------- |
| `GET /api/auth/saml/<slug>/login`    | SP-initiated sign-in (redirects to IdP). |
| `POST /api/auth/saml/<slug>/acs`     | Assertion Consumer Service (callback).   |
| `GET /api/auth/saml/<slug>/metadata` | SP metadata XML for IdP registration.    |
| `GET /api/auth/saml/<slug>/slo`      | Single-logout (SP-initiated).            |

The `<slug>` is the URL-safe identifier you choose when creating the provider.
It cannot be changed once the provider is created (changing it would break
in-flight sign-in attempts).

## Setting up a SAML provider

### 1. Generate the SP signing keypair

The Service Provider (this app) signs every AuthnRequest with its private key
so the IdP can confirm the request came from the registered SP. Generate a
fresh keypair before adding the provider:

```sh
openssl req -x509 -newkey rsa:2048 \
  -keyout sp.key -out sp.crt \
  -nodes -days 1825 \
  -subj "/CN=<slug>"
```

The private key is encrypted at rest by AES-256-GCM via
`APP_ENCRYPTION_KEY`; the public certificate is published in SP metadata.

### 2. Add the provider in the admin UI

1. Navigate to **Admin → Authentication → Add provider** and pick **SAML 2.0**.
2. Fill in:
   - **Display name** - shown on the login button.
   - **Slug** - URL-safe identifier (lowercase, dashes; e.g. `corp-sso`).
   - **IdP entityID** - the IdP's Issuer URI.
   - **IdP SSO URL** - the IdP's SAML 2.0 sign-in endpoint (HTTP-Redirect
     binding).
   - **IdP SLO URL** _(optional)_ - Single Logout endpoint.
   - **IdP signing certificate** - paste the public PEM cert the IdP uses to
     sign Responses.
   - **SP private key + cert** - paste the PEMs you generated above.
3. Save. Copy the SP metadata URL from the provider detail page -
   `/api/auth/saml/<slug>/metadata` - and register it in your IdP.

### 3. Register the SP with the IdP

Most IdPs accept SP metadata via URL or uploaded XML file. Worked examples:

#### Authentik SAML

1. **Providers → Create → SAML Provider**.
2. **Authorization flow:** `default-provider-authorization-implicit-consent`.
3. **ACS URL:** `https://<app-url>/api/auth/saml/<slug>/acs`.
4. **Audience / Issuer:** `https://<app-url>/api/auth/saml/<slug>/metadata`
   (this is the SP entityID PowerDNS-AuthAdmin derives from APP_URL + slug).
5. **Signing key/certificate:** select the keypair Authentik should sign with.
   Then go back to PowerDNS-AuthAdmin and paste that public cert into
   **IdP signing certificate**.
6. **Property mappings** - at minimum: an `email` mapping for the user's
   email. Optional: `groups` mapping for group → role assignments.
7. Create an **Application** bound to this Provider and assign the relevant
   users / groups.

#### Keycloak SAML

1. **Clients → Create client → SAML**.
2. **Client ID:** `https://<app-url>/api/auth/saml/<slug>/metadata`.
3. **Root URL:** `https://<app-url>`.
4. **Valid Redirect URIs:** `https://<app-url>/*`.
5. **Master SAML Processing URL / ACS:**
   `https://<app-url>/api/auth/saml/<slug>/acs`.
6. **Signing keys → Client signing key:** import the SP public cert
   (`sp.crt`).
7. **Client scopes → Mappers** - add at minimum:
   - User Property `email` → SAML Attribute `email`.
   - User Property `firstName` → SAML Attribute `name` (or compose).
   - (Optional) Group List → SAML Attribute `groups`.

Then in PowerDNS-AuthAdmin paste Keycloak's IdP signing certificate
(under **Realm Settings → Keys**) into **IdP signing certificate**.

#### AD FS

1. **AD FS Management → Relying Party Trusts → Add Relying Party Trust**.
2. **Import data about the relying party from a file** - point at the SP
   metadata XML (download from `/api/auth/saml/<slug>/metadata`).
3. **Access Control Policy:** Permit everyone (or scope as required).
4. **Edit Claim Issuance Policy → Add Rule → Send LDAP Attributes as Claims:**
   - LDAP attribute: `E-Mail-Addresses` → Outgoing claim: `email`.
   - LDAP attribute: `Display-Name` → Outgoing claim: `name`.
   - (Optional) Token-Groups - Unqualified Names → Outgoing claim: `groups`.
5. Copy the AD FS Token-signing certificate from
   **Service → Certificates** and paste it into PowerDNS-AuthAdmin's
   **IdP signing certificate** field.

## Group → role mapping

Same shape as OIDC. On every successful sign-in, the user's group attribute
(default `groups`) is matched against the provider's mappings; each match
materialises a `role_assignments` row tagged with `provider_id` = this
provider's id. Removed groups → revoked assignments. Admin-issued
assignments are never touched.

## Encrypted assertions (optional)

If you want the IdP to encrypt assertions to this SP:

1. Generate a second keypair the same way and save it as `sp-enc.key` /
   `sp-enc.crt`.
2. In the provider form, tick **Configure assertion encryption keypair** and
   paste the new PEMs.
3. Update the IdP's SP registration with the new encryption cert (most IdPs
   advertise the encryption cert separately from the signing cert).
4. Tick **Require encrypted Assertion** if you want to refuse plaintext
   assertions.

## Provisioning (`provisioning.yaml`)

```yaml
saml:
  - slug: corp-sso
    name: Corporate SSO
    idp_entity_id: https://idp.example.com/saml
    idp_sso_url: https://idp.example.com/saml/sso
    idp_slo_url: https://idp.example.com/saml/slo
    idp_signing_cert: |
      -----BEGIN CERTIFICATE-----
      ...
      -----END CERTIFICATE-----
    sp_signing_key: |
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
    sp_signing_cert: |
      -----BEGIN CERTIFICATE-----
      ...
      -----END CERTIFICATE-----
    claim_email: email
    claim_name: name
    claim_groups: groups
    group_mappings:
      - group: DomainAdmins
        role: super-admin
        scope: global
      - group: NetOps
        role: operator
        scope: global
```

See [`provisioning.example.yaml`](../provisioning.example.yaml) for the full
schema.

## Troubleshooting

- **`saml-state-missing`** - the `pda_saml_state` cookie wasn't set when the
  ACS handler ran. Usually means the user's session expired between /login
  and the IdP round-trip (10-minute TTL), they switched browsers, or their
  browser blocked third-party cookies on the IdP origin.
- **`saml-exchange-failed`** - the assertion failed verification. Check the
  app logs for the specific `saml.acs.verify-failed` line; common causes:
  - **InResponseTo mismatch** - the IdP replied to a different RequestID
    (sometimes happens when the IdP holds onto a stale session).
  - **Signature verification failed** - the IdP's signing cert changed
    and you haven't updated the **IdP signing certificate** field.
  - **`wantAuthnResponseSigned` failed** - the IdP signs only the inner
    assertion; turn off **Require signed Response** on the provider.
- **`saml-not-authorized`** - the email domain wasn't in the allow-list.
  Check the provider's **Override OIDC_ALLOWED_EMAIL_DOMAINS** setting.
