## lib/security

Security helpers used across the app, currently CSP construction and SVG
sanitization.

Keep reusable security policy here. Request-level header application lives in
`proxy.ts`, and validation of user input belongs under `lib/validators`.
