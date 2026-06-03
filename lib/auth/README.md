## lib/auth

Authentication and account-security domain code: sessions, password handling,
CSRF, MFA, WebAuthn, password reset, signup policy, rate limiting, and external
identity providers.

Modules here are server-only. UI belongs under `app/` or `components/`, and
authorization policy belongs under `lib/rbac`.
