## lib/client

Browser-only helpers shared by client components, currently the CSRF-aware
`apiFetch` mutation wrapper.

Do not put server-only code, secrets, database access, or PowerDNS calls here.
Anything in this directory must be safe for the browser bundle.
