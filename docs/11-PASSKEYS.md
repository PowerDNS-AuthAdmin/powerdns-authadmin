# Passkeys & security keys (WebAuthn)

PowerDNS-AuthAdmin supports WebAuthn credentials — passkeys (Touch ID, Windows
Hello, Android screen lock, iCloud Keychain, 1Password / Bitwarden cross-device
passkeys) and hardware security keys (YubiKey, SoloKeys, Titan, Feitian).

A credential can be used **two ways**:

- **Sign in directly** — no password. "Sign in with passkey" on the login
  page picks the credential bound to this site and prompts you for the
  device's user verification (biometric, PIN, or just tap, depending on
  the authenticator).
- **As a second factor** — after a successful password, the login page
  prompts for either an authenticator code (TOTP) or a passkey.

Either method satisfies a role's **Require MFA** policy.

## Enrol a passkey

1. Sign in, open **Profile → Two-factor**.
2. Under **Passkeys & security keys**, click **Add a passkey**.
3. Give it a name (e.g. "MacBook Touch ID", "YubiKey 5"). Pick a name you'll
   recognise on the list later.
4. Complete the platform prompt — biometric, PIN, or security-key tap.
5. The new credential shows up under "Passkeys & security keys".

You can enrol as many as you want. Each one is removable individually from
the same page.

## Sign in with a passkey (no password)

1. On the login page, click **Sign in with passkey** (the button under the
   password form).
2. Pick your credential when the platform prompts. macOS / iOS show a
   chooser sheet; Windows Hello shows a system prompt; security keys
   blink and ask for a tap.
3. You're signed in. No password entry.

If the platform doesn't show the chooser at all, your browser may not
have a credential bound to this host — switch to the password flow and
enrol one from `Profile → Two-factor` first.

## Sign in with a passkey as second factor

1. Submit your password as usual.
2. When the MFA step appears, pick **Passkey** in the tab switcher
   (it's selected automatically if you only have a passkey enrolled).
3. Complete the platform prompt.

## Platform support

| Platform                       | Built-in passkey provider              | Hardware keys   |
| ------------------------------ | -------------------------------------- | --------------- |
| iOS 16+ / iPadOS 16+           | iCloud Keychain                        | NFC / Lightning |
| Android 9+                     | Google Password Manager (Android 14+)  | NFC / USB       |
| macOS 13+                      | iCloud Keychain (Safari, Chrome, Edge) | USB-A/C, NFC    |
| Windows 10/11                  | Windows Hello                          | USB-A/C, NFC    |
| Linux                          | Browser-specific (Firefox / Chromium)  | USB             |
| 1Password, Bitwarden, Dashlane | Cross-device passkey storage           | n/a             |

Hardware security keys (YubiKey 5 series, SoloKeys v2, Titan, Feitian
BioPass) work on every platform with a USB / NFC connector regardless of
OS — they're the most portable option.

## Configuration

Everything's auto-derived from `APP_URL` and the site name. Override only
when you need to.

| Env var                           | Default                          | Notes                                                                                                                          |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `WEBAUTHN_ENABLED`                | `true`                           | Master kill-switch. Hides the passkey button + the profile section.                                                            |
| `WEBAUTHN_RP_ID`                  | `APP_URL` hostname               | Bare hostname only (no scheme, no path). Override for apex/sub-domain credential sharing — see "Behind a reverse proxy" below. |
| `WEBAUTHN_RP_NAME`                | site name from `/admin/settings` | Shown by the platform at the registration prompt ("Add a passkey for X").                                                      |
| `WEBAUTHN_USER_VERIFICATION`      | `preferred`                      | `required` to force biometric / PIN; `discouraged` for U2F-style speed.                                                        |
| `WEBAUTHN_ATTESTATION`            | `none`                           | `none` (privacy-preserving) or `direct` (surfaces attestation statements for audit-grade deployments).                         |
| `WEBAUTHN_ALLOW_INSECURE_ORIGINS` | `false`                          | Allow `http://` origins (LAN dev without TLS). Production has no business loosening this.                                      |

### Behind a reverse proxy

WebAuthn binds to an **origin** and an **rpId** (registrable hostname). Both
must match the URL the browser uses. Same constraint as the cookie-domain
case documented in
[Installation → Set APP_URL](./02-INSTALLATION.md#2-set-app_url) and
[Installation → Behind a reverse proxy](./02-INSTALLATION.md#behind-a-reverse-proxy):

- Set `APP_URL` to the public URL (`https://dns.example.com`).
- The reverse proxy must forward `X-Forwarded-Host` and `X-Forwarded-Proto`
  so the app reconstructs the correct origin during the verify step.
- Override `WEBAUTHN_RP_ID` only if you want the same credential to work
  across sub-domains (e.g. set `example.com` and enrol from
  `auth.example.com` to use the credential at `dns.example.com`).

## Lost passkey / admin reset

Sign in to another factor (TOTP, password+TOTP, or a different passkey)
and remove the lost credential from `Profile → Two-factor`.

If you can't get in at all:

- An admin can remove any individual credential from your account via
  `/admin/users/<id>` → MFA panel.
- The TARGET-privilege ceiling applies — an admin can't remove
  credentials from an account that holds permissions they don't.

## Troubleshooting

| Symptom                                                                  | Likely cause                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Platform prompt cancels / "No credentials found"                         | Browser has no credential bound to this `rpId`. Enrol from Profile first.                                                 |
| `NotAllowedError` on enrol                                               | Operator dismissed the platform prompt (Cancel / closed Touch ID). Try again.                                             |
| `SecurityError: The relying party ID is not a registrable domain suffix` | `WEBAUTHN_RP_ID` doesn't match the browser URL. Set it to the bare hostname (no scheme, no port, no path).                |
| Sign-in fails with "Credential not registered to this account"           | A credential was removed but the device's stored copy is still being offered. Remove it from the platform's settings too. |
| Counter rollback rejection in audit log                                  | Cloned authenticator or replay. Failed assertion; user retries normally.                                                  |

For deeper logs: `auth.mfa.webauthn.*` audit rows record every enrol /
remove / rename. `auth.login.success` with `method=webauthn-primary` or
`method=webauthn-second-factor` confirms a passkey sign-in.

---

[← Docs index](./README.md)
